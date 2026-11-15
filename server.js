'use strict';

require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// -----------------------------------------------------------------------------
// Environment and validation
// -----------------------------------------------------------------------------
const ENV = {
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID,
  VERIFY_TOKEN: process.env.VERIFY_TOKEN,
  APP_SECRET: process.env.APP_SECRET,
  GRAPH_VERSION: process.env.GRAPH_VERSION || 'v21.0',
  TICKET_PREFIX: process.env.TICKET_PREFIX || 'SR',
  SALES_PREFIX: process.env.SALES_PREFIX || 'SL',
  PORT: Number(process.env.PORT || 3000),
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  AI_ENABLED: String(process.env.AI_ENABLED || 'true').toLowerCase() === 'true',
  BUSINESS_NAME: process.env.BUSINESS_NAME || 'VARAH TECHNOLOGY',
  BUSINESS_PHONE: process.env.BUSINESS_PHONE || '+91 9549308371',
  BUSINESS_ADDRESS: process.env.BUSINESS_ADDRESS || 'Opp. Sagar Palace Hotel, Station Road, Bhinmal, Rajasthan',
  SESSION_TTL_MS: Number(process.env.SESSION_TTL_MS || 6 * 60 * 60 * 1000),
  MAX_BODY_BYTES: process.env.MAX_BODY_BYTES || '1mb',
  LOG_MESSAGES: String(process.env.LOG_MESSAGES || 'false').toLowerCase() === 'true',
};

for (const key of ['WHATSAPP_TOKEN', 'PHONE_NUMBER_ID', 'VERIFY_TOKEN', 'APP_SECRET']) {
  if (!ENV[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}
if (!Number.isInteger(ENV.PORT) || ENV.PORT < 1 || ENV.PORT > 65535) {
  console.error('PORT must be a valid TCP port.');
  process.exit(1);
}

// -----------------------------------------------------------------------------
// Firebase Admin. Keep existing Firestore collections/fields compatible.
// -----------------------------------------------------------------------------
function loadServiceAccount() {
  if (process.env.FIREBASE_CREDENTIALS) {
    try {
      return JSON.parse(process.env.FIREBASE_CREDENTIALS);
    } catch {
      throw new Error('FIREBASE_CREDENTIALS is not valid JSON.');
    }
  }
  try {
    return require('./serviceAccountKey.json');
  } catch {
    throw new Error('Set FIREBASE_CREDENTIALS or add serviceAccountKey.json locally.');
  }
}

if (!getApps().length) {
  initializeApp({ credential: cert(loadServiceAccount()) });
}
const db = getFirestore();
const app = express();
app.disable('x-powered-by');
app.use(express.json({
  limit: ENV.MAX_BODY_BYTES,
  verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); },
}));

const openai = ENV.OPENAI_API_KEY ? new OpenAI({ apiKey: ENV.OPENAI_API_KEY }) : null;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
const now = () => FieldValue.serverTimestamp();
const clean = (value, max = 1000) => String(value || '').trim().slice(0, max);
const normalizePhone = (value) => String(value || '').replace(/\D/g, '');
const isGreeting = (s) => /^(hi|hii+|hello|hey|namaste|नमस्ते|हेलो)$/i.test(s);
const isMenu = (s) => /^(menu|0|start|शुरू|मेन्यू)$/i.test(s);
const isHuman = (s) => /^(agent|human|staff|person|कर्मचारी|इंसान|सपोर्ट)$/i.test(s);

const MENU_TEXT =
  `Namaste! 🙏 *${ENV.BUSINESS_NAME}* mein aapka swagat hai.\n` +
  `Welcome to ${ENV.BUSINESS_NAME} – CCTV & Security Solutions.\n\n` +
  `Aapko kis cheez mein madad chahiye? / How can we help?\n\n` +
  `*1.* CCTV Sales / New Installation\n` +
  `*2.* CCTV Repair / Service Request\n` +
  `*3.* Existing Ticket Status\n` +
  `*4.* Product / Technical Support\n` +
  `*5.* Quotation / Price Enquiry\n` +
  `*6.* Talk to Support Team\n\n` +
  `Reply with 1–6. Type *MENU* anytime to return here.`;

function textOf(message) {
  if (message.type === 'text') return clean(message.text?.body, 4000);
  if (message.type === 'button') return clean(message.button?.text, 1000);
  if (message.type === 'interactive') {
    const reply = message.interactive?.button_reply || message.interactive?.list_reply;
    return clean(reply?.id || reply?.title, 1000);
  }
  if (message.type === 'image') return '[Customer sent an image]';
  if (message.type === 'video') return '[Customer sent a video]';
  if (message.type === 'document') return '[Customer sent a document]';
  if (message.type === 'audio') return '[Customer sent audio]';
  if (message.type === 'location') return '[Customer shared a location]';
  return '';
}

function validSignature(req) {
  const signature = req.get('x-hub-signature-256') || '';
  if (!/^sha256=[a-f0-9]{64}$/i.test(signature) || !req.rawBody) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', ENV.APP_SECRET)
    .update(req.rawBody)
    .digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function sendMessage(to, body) {
  const recipient = normalizePhone(to);
  if (!recipient) throw new Error('Invalid WhatsApp recipient.');
  const response = await axios.post(
    `https://graph.facebook.com/${ENV.GRAPH_VERSION}/${ENV.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'text',
      text: { preview_url: false, body: clean(body, 4096) },
    },
    {
      timeout: 15000,
      headers: {
        Authorization: `Bearer ${ENV.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
  return response.data;
}

async function safeSend(to, body) {
  try {
    return await sendMessage(to, body);
  } catch (error) {
    console.error('WhatsApp send failed:', error.response?.data || error.message);
    return null;
  }
}

async function nextTicket(kind) {
  const isSales = kind === 'sales';
  const prefix = isSales ? ENV.SALES_PREFIX : ENV.TICKET_PREFIX;
  const counterRef = db.collection('counters').doc(isSales ? 'waSalesLeads' : 'waLeads');
  const number = await db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const next = (snap.exists && Number.isFinite(snap.data().n) ? snap.data().n : 1000) + 1;
    tx.set(counterRef, { n: next, updatedAt: now() }, { merge: true });
    return next;
  });
  return `${prefix}-${number}`;
}

async function saveLead({ from, profileName, details, type, messageId, category }) {
  const ticketId = await nextTicket(type);
  const lead = {
    ticketId,
    phone: normalizePhone(from),
    name: clean(profileName, 120),
    message: clean(details, 3000),
    type: type === 'sales' ? 'sales' : 'service',
    category: clean(category, 80),
    status: 'new',
    source: 'whatsapp',
    waMessageId: messageId || '',
    createdAt: now(),
    updatedAt: now(),
  };
  const doc = await db.collection('leads').add(lead);
  return { ticketId, leadId: doc.id, lead };
}

async function updateSession(ref, data) {
  await ref.set({ ...data, updatedAt: now() }, { merge: true });
}

async function setMenu(from, ref, intro = '') {
  await updateSession(ref, { step: 'menu', type: null, collected: {} });
  await safeSend(from, `${intro ? intro + '\n\n' : ''}${MENU_TEXT}`);
}

async function findTicket(ticketId, phone) {
  const snap = await db.collection('leads')
    .where('ticketId', '==', clean(ticketId, 40))
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  const lead = doc.data();
  // Do not disclose a ticket to a different WhatsApp number.
  if (normalizePhone(lead.phone) !== normalizePhone(phone)) return null;
  return lead;
}

// -----------------------------------------------------------------------------
// Optional AI: intent classification and short bilingual replies.
// AI is constrained to routing; it cannot create/update records by itself.
// -----------------------------------------------------------------------------
async function classifyWithAI(text, currentStep) {
  if (!ENV.AI_ENABLED || !openai || !text || text.length > 1500) return null;
  try {
    const completion = await openai.chat.completions.create({
      model: ENV.OPENAI_MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You classify customer messages for an Indian CCTV company. Return JSON only: ' +
            '{"intent":"sales|service|status|technical|quotation|human|menu|other",' +
            '"language":"hi|en|mixed","summary":"short plain summary","reply":"brief helpful bilingual reply or empty"}. ' +
            'Do not invent prices, warranties, availability, ticket status, or claim an action was completed. ' +
            'If uncertain use intent other. Current flow step: ' + currentStep,
        },
        { role: 'user', content: text },
      ],
    });
    const parsed = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
    const allowed = new Set(['sales', 'service', 'status', 'technical', 'quotation', 'human', 'menu', 'other']);
    if (!allowed.has(parsed.intent)) return null;
    return {
      intent: parsed.intent,
      language: ['hi', 'en', 'mixed'].includes(parsed.language) ? parsed.language : 'mixed',
      summary: clean(parsed.summary, 300),
      reply: clean(parsed.reply, 700),
    };
  } catch (error) {
    console.error('AI classification failed; using menu rules:', error.message);
    return null;
  }
}

function intentToChoice(intent) {
  return ({
    sales: '1',
    service: '2',
    status: '3',
    technical: '4',
    quotation: '5',
    human: '6',
    menu: 'menu',
  })[intent] || null;
}

// -----------------------------------------------------------------------------
// Message workflow
// -----------------------------------------------------------------------------
async function handleMessage(message, profileName) {
  const from = normalizePhone(message.from);
  if (!from || !message.id) return;

  // Atomic idempotency: Firestore create fails if the document already exists.
  const processedRef = db.collection('wa_processed').doc(message.id);
  try {
    await processedRef.create({ at: now(), from });
  } catch (error) {
    if (error.code === 6 || error.code === 'already-exists') return;
    throw error;
  }

  const text = textOf(message);
  const low = text.toLowerCase();
  const sessionRef = db.collection('whatsapp_sessions').doc(from);
  const sessionSnap = await sessionRef.get();
  let session = sessionSnap.exists ? sessionSnap.data() : null;
  if (session?.updatedAt?.toMillis &&
      Date.now() - session.updatedAt.toMillis() > ENV.SESSION_TTL_MS) {
    session = null;
    await sessionRef.delete().catch(() => {});
  }

  if (isMenu(low) || isGreeting(low) || !session) {
    await setMenu(from, sessionRef, isGreeting(low) ? 'Namaste! / Hello!' : '');
    return;
  }

  if (isHuman(low)) {
    await db.collection('wa_handoffs').add({
      phone: from, name: clean(profileName, 120), status: 'open',
      source: 'whatsapp', createdAt: now(),
    });
    await safeSend(from,
      'Aapki request hamari support team ko bhej di gayi hai. ✅\n' +
      'Our support team will contact you soon. Working hours ke dauran reply milega.\n\nType MENU for main menu.');
    return;
  }

  // While waiting for a ticket number, validate ownership before showing status.
  if (session.step === 'ticket_status') {
    const ticket = await findTicket(text, from);
    if (!ticket) {
      await safeSend(from, 'Ticket nahi mila, ya yeh number is WhatsApp account se match nahi karta. Kripya sahi Ticket Number bhejein. / Ticket not found. Send MENU to return.');
      return;
    }
    await safeSend(from,
      `🎫 *${ticket.ticketId}*\nStatus: *${clean(ticket.status || 'new', 40)}*\n` +
      `Type: ${ticket.type === 'sales' ? 'Sales Enquiry' : 'Service Request'}\n` +
      `Our team will contact you for the latest update.`);
    await setMenu(from, sessionRef);
    return;
  }

  // AI intent detection when user writes naturally instead of choosing a number.
  if (session.step === 'menu' && !/^[1-6]$/.test(low)) {
    const ai = await classifyWithAI(text, session.step);
    const choice = ai && intentToChoice(ai.intent);
    if (choice) {
      if (choice === 'menu') return setMenu(from, sessionRef);
      await updateSession(sessionRef, {
        step: choice === '3' ? 'ticket_status' : choice === '4' ? 'technical' : choice === '6' ? 'human' : 'ask_details',
        type: ['1', '5'].includes(choice) ? 'sales' : 'service',
        category: choice,
      });
      if (choice === '3') return safeSend(from, 'Kripya apna Ticket Number bhejein. / Please send your Ticket Number.');
      if (choice === '4') return safeSend(from, 'Apni CCTV problem aur device model bhejein. / Please share the issue and device model.');
      if (choice === '6') return safeSend(from, 'Apna message bhejein. Hamari team ko notify kiya jayega. / Send your message for our support team.');
      return askDetails(from, choice);
    }
    await safeSend(from, ai?.reply || 'Kripya 1 se 6 mein se option chunein. / Please choose an option from 1 to 6.');
    return;
  }

  const choice = low;
  if (session.step === 'menu') {
    if (choice === '3') {
      await updateSession(sessionRef, { step: 'ticket_status' });
      await safeSend(from, 'Kripya apna Ticket Number bhejein. / Please send your Ticket Number.');
      return;
    }
    if (choice === '4') {
      await updateSession(sessionRef, { step: 'technical', type: 'service' });
      await safeSend(from, 'Apni CCTV problem aur device model bhejein. / Please share your issue and device model.');
      return;
    }
    if (choice === '6') {
      await updateSession(sessionRef, { step: 'human' });
      await safeSend(from, 'Apna message bhejein. Hamari team ko notify kiya jayega. / Send your message for our support team.');
      return;
    }
    if (['1', '2', '5'].includes(choice)) {
      const type = choice === '1' || choice === '5' ? 'sales' : 'service';
      await updateSession(sessionRef, { step: 'ask_details', type, category: choice });
      return askDetails(from, choice);
    }
    await safeSend(from, 'Invalid option. Kripya 1 se 6 tak ka option chunein. / Please choose 1 to 6.');
    return;
  }

  if (session.step === 'human') {
    await db.collection('wa_handoffs').add({
      phone: from, name: clean(profileName, 120), message: text,
      status: 'open', source: 'whatsapp', createdAt: now(),
    });
    await safeSend(from, 'Dhanyawad! Aapka message support team ko bhej diya gaya hai. ✅');
    await setMenu(from, sessionRef);
    return;
  }

  if (session.step === 'technical') {
    const result = await saveLead({ from, profileName, details: text, type: 'service', messageId: message.id, category: 'technical_support' });
    await safeSend(from, `Technical support request registered. ✅\nTicket: *${result.ticketId}*\nHamari team aapse sampark karegi. / Our team will contact you.`);
    await setMenu(from, sessionRef);
    return;
  }

  if (session.step === 'ask_details') {
    if (text.length < 8 || isGreeting(low) || isMenu(low)) {
      await safeSend(from, 'Kripya thodi aur details bhejein (naam, city/location aur requirement/problem). / Please include your name, location and requirement/problem.');
      return;
    }
    const result = await saveLead({
      from, profileName, details: text,
      type: session.type || 'service',
      messageId: message.id,
      category: session.category === '5' ? 'quotation' : session.category === '1' ? 'new_installation' : session.category === '2' ? 'repair_service' : 'general',
    });
    const confirmation = `Dhanyawad ${clean(profileName, 80)}! Aapki request darj ho gayi hai. ✅\nThank you! Your request has been registered.\n\n🎫 Ticket: *${result.ticketId}*\nHamari team jald sampark karegi. / Our team will contact you soon.\n\nType *MENU* for more options.`;
    await safeSend(from, confirmation);
    await setMenu(from, sessionRef);
    return;
  }

  await setMenu(from, sessionRef, 'Let us start again. / Chaliye dobara shuru karte hain.');
}

async function askDetails(from, choice) {
  const prompts = {
    '1': 'Naya CCTV Setup / Sales 🛒\nKripya Naam, Location, kitne cameras chahiye aur indoor/outdoor requirement bhejein.\nPlease share your name, location, number of cameras and requirement.',
    '2': 'CCTV Repair / Service 🛠️\nKripya Naam, Location, CCTV/DVR model aur problem bhejein.\nPlease share your name, location, device model and issue.',
    '5': 'Quotation / Price Enquiry 🧾\nKripya Naam, Location, camera quantity aur requirement bhejein. Team quotation ke liye sampark karegi.',
  };
  await safeSend(from, prompts[choice] || prompts['2']);
}

// -----------------------------------------------------------------------------
// Webhook endpoints
// -----------------------------------------------------------------------------
app.get('/', (_req, res) => res.status(200).send('VARAH TECHNOLOGY WhatsApp Bot is running ✅'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true, service: 'varah-whatsapp-bot' }));

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === ENV.VERIFY_TOKEN && challenge) {
    return res.status(200).type('text/plain').send(String(challenge));
  }
  return res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  if (!validSignature(req)) return res.sendStatus(401);

  // Acknowledge Meta immediately. Process asynchronously.
  res.sendStatus(200);
  const body = req.body || {};
  if (body.object !== 'whatsapp_business_account') return;

  setImmediate(async () => {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const profileName = clean(value.contacts?.[0]?.profile?.name, 120);
        for (const message of value.messages || []) {
          try {
            await handleMessage(message, profileName);
          } catch (error) {
            console.error('Message processing failed:', error.response?.data || error.message);
          }
        }
        // Delivery/read statuses can be persisted for CRM message tracking.
        for (const status of value.statuses || []) {
          try {
            await db.collection('wa_message_status').doc(status.id).set({
              id: status.id,
              status: status.status,
              recipientId: status.recipient_id || '',
              timestamp: status.timestamp || '',
              updatedAt: now(),
            }, { merge: true });
          } catch (error) {
            console.error('Status persistence failed:', error.message);
          }
        }
      }
    }
  });
});

app.use((error, _req, res, _next) => {
  console.error('Express error:', error.message);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(ENV.PORT, () => {
  console.log(`VARAH WhatsApp Bot listening on ${ENV.PORT}`);
});

function shutdown(signal) {
  console.log(`${signal} received; shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
