'use strict';

require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// 🚨 ERROR CATCHER (Taaki agar crash ho toh exact error dikhe)
process.on('uncaughtException', (err) => {
  console.error('🚨 FATAL ERROR:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('🚨 UNHANDLED REJECTION:', reason);
  process.exit(1);
});

// -----------------------------------------------------------------------------
// Environment and validation
// -----------------------------------------------------------------------------
const ENV = {
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID,
  VERIFY_TOKEN: process.env.VERIFY_TOKEN,
  APP_SECRET: process.env.APP_SECRET,
  GRAPH_VERSION: process.env.GRAPH_VERSION || 'v21.0',
  TICKET_PREFIX: process.env.TICKET_PREFIX || 'VT', // Premium Ticket Prefix
  SALES_PREFIX: process.env.SALES_PREFIX || 'VT',
  PORT: Number(process.env.PORT || 3000),
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  AI_ENABLED: String(process.env.AI_ENABLED || 'false').toLowerCase() === 'true',
  BUSINESS_NAME: process.env.BUSINESS_NAME || 'VARAH TECHNOLOGY',
  BUSINESS_PHONE: process.env.BUSINESS_PHONE || '+91 9549308371',
  BUSINESS_ADDRESS: process.env.BUSINESS_ADDRESS || 'Opp. Sagar Palace Hotel, Station Road, Bhinmal, Rajasthan',
  SESSION_TTL_MS: Number(process.env.SESSION_TTL_MS || 6 * 60 * 60 * 1000),
  MAX_BODY_BYTES: process.env.MAX_BODY_BYTES || '1mb',
};

console.log("1. Environment variables check kar rahe hain...");
for (const key of ['WHATSAPP_TOKEN', 'PHONE_NUMBER_ID', 'VERIFY_TOKEN', 'APP_SECRET']) {
  if (!ENV[key]) {
    console.error(`❌ Missing required environment variable: ${key}`);
    process.exit(1);
  }
}
console.log("✅ Saare environment variables mil gaye.");

// -----------------------------------------------------------------------------
// Firebase Admin Setup
// -----------------------------------------------------------------------------
console.log("2. Firebase credentials load kar rahe hain...");
function loadServiceAccount() {
  if (process.env.FIREBASE_CREDENTIALS) {
    try {
      return JSON.parse(process.env.FIREBASE_CREDENTIALS);
    } catch (e) {
      console.error('❌ FIREBASE_CREDENTIALS is not valid JSON. Please minify it properly.');
      process.exit(1);
    }
  }
  try {
    return require('./serviceAccountKey.json');
  } catch {
    console.error('❌ Local "serviceAccountKey.json" nahi mili. Laptop par test karne ke liye file rakhein.');
    process.exit(1);
  }
}

try {
  if (!getApps().length) {
    initializeApp({ credential: cert(loadServiceAccount()) });
  }
  console.log("✅ Firebase initialize ho gaya.");
} catch (error) {
  console.error("❌ Firebase init fail ho gaya:", error.message);
  process.exit(1);
}

const db = getFirestore();
const app = express();
app.disable('x-powered-by');
app.use(express.json({
  limit: ENV.MAX_BODY_BYTES,
  verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); },
}));

const openai = ENV.OPENAI_API_KEY && ENV.AI_ENABLED ? new OpenAI({ apiKey: ENV.OPENAI_API_KEY }) : null;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
const now = () => FieldValue.serverTimestamp();
const clean = (value, max = 1000) => String(value || '').trim().slice(0, max);
const normalizePhone = (value) => String(value || '').replace(/\D/g, '');
const isGreeting = (s) => /^(hi|hii+|hello|hey)$/i.test(s);
const isMenu = (s) => /^(menu|0|start)$/i.test(s);

// PROFESSIONAL MENU TEXT (No Emojis, Pure English)
const MENU_TEXT =
  `Welcome to *${ENV.BUSINESS_NAME}*.\n` +
  `Premium CCTV & Security Solutions.\n\n` +
  `How may we assist you today?\n\n` +
  `*1.* New CCTV Installation & Sales\n` +
  `*2.* Repair & Technical Service\n` +
  `*3.* Check Existing Ticket Status\n` +
  `*4.* Product Quotation & Pricing\n` +
  `*5.* Speak to a Support Agent\n\n` +
  `Please reply with a number (1-5). Type *MENU* anytime to return.`;

function textOf(message) {
  if (message.type === 'text') return clean(message.text?.body, 4000);
  if (message.type === 'button') return clean(message.button?.text, 1000);
  if (message.type === 'interactive') {
    const reply = message.interactive?.button_reply || message.interactive?.list_reply;
    return clean(reply?.id || reply?.title, 1000);
  }
  if (message.type === 'image') return '[Image Received]';
  if (message.type === 'video') return '[Video Received]';
  if (message.type === 'document') return '[Document Received]';
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
  if (normalizePhone(lead.phone) !== normalizePhone(phone)) return null;
  return lead;
}

// -----------------------------------------------------------------------------
// Message workflow
// -----------------------------------------------------------------------------
async function handleMessage(message, profileName) {
  const from = normalizePhone(message.from);
  if (!from || !message.id) return;

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
  
  if (session?.updatedAt?.toMillis && Date.now() - session.updatedAt.toMillis() > ENV.SESSION_TTL_MS) {
    session = null;
    await sessionRef.delete().catch(() => {});
  }

  if (isMenu(low) || isGreeting(low) || !session) {
    await setMenu(from, sessionRef, isGreeting(low) ? 'Welcome.' : '');
    return;
  }

  if (session.step === 'ticket_status') {
    const ticket = await findTicket(text, from);
    if (!ticket) {
      await safeSend(from, `We could not find a ticket with this ID associated to your number.\nPlease verify the Ticket ID or type *MENU* to return.`);
      return;
    }
    await safeSend(from,
      `🎫 *Ticket ID:* ${ticket.ticketId}\n` +
      `*Status:* ${clean(ticket.status || 'new', 40).toUpperCase()}\n` +
      `*Service Type:* ${ticket.type === 'sales' ? 'Sales & Installation' : 'Technical Service'}\n\n` +
      `Our team is reviewing your request.`);
    await setMenu(from, sessionRef);
    return;
  }

  if (session.step === 'menu') {
    if (low === '3') {
      await updateSession(sessionRef, { step: 'ticket_status' });
      await safeSend(from, 'Please provide your *Ticket ID* to check the status.\n(Example: VT-1001)');
      return;
    }
    if (low === '5') {
      await db.collection('wa_handoffs').add({
        phone: from, name: clean(profileName, 120), status: 'open', source: 'whatsapp', createdAt: now(),
      });
      await safeSend(from, 'Your request has been forwarded to our support team. ✅\nA representative will contact you shortly.\n\nType *MENU* to return.');
      await sessionRef.delete();
      return;
    }
    if (['1', '2', '4'].includes(low)) {
      const type = (low === '1' || low === '4') ? 'sales' : 'service';
      await updateSession(sessionRef, { step: 'ask_details', type, category: low });
      
      const prompt = low === '1' ? 'Please provide your *Name*, *City*, and the *Number of Cameras* required.' :
                     low === '2' ? 'Please provide your *Name*, *Location*, and a brief description of the *Issue*.' :
                                   'Please provide your *Name*, *Location*, and your specific *Pricing Requirement*.';
      await safeSend(from, prompt);
      return;
    }
    await safeSend(from, 'Invalid selection. Please reply with a number from 1 to 5.');
    return;
  }

  if (session.step === 'ask_details') {
    const invalidKeywords = ['hi', 'hello', 'hey', 'ok', 'yes', 'no'];
    
    if (!text || text.length < 8 || invalidKeywords.includes(low) || isGreeting(low)) {
      await safeSend(from, 
        `We were unable to process your request as the details are incomplete.\n\n` +
        `Please provide your *Name*, *Location*, and *Requirement* in a single message.\n` +
        `_(Example: Rahul Sharma - Jaipur - Need 4 outdoor cameras)_`);
      return; 
    }

    const result = await nextTicket(session.type || 'service');
    await db.collection('leads').add({
      ticketId: result,
      phone: from,
      name: clean(profileName, 120),
      message: clean(text, 3000),
      type: session.type || 'service',
      status: 'new',
      source: 'whatsapp',
      category: session.category || 'general',
      createdAt: now(),
      updatedAt: now(),
    });
    
    await safeSend(from, 
      `Thank you, ${clean(profileName, 80) || 'Customer'}. ✅\n\n` +
      `Your request has been successfully registered.\n` +
      `🎫 *Reference ID:* ${result}\n\n` +
      `A representative from VARAH TECHNOLOGY will contact you shortly.\n\n` +
      `Type *MENU* for further assistance.`);
    
    await sessionRef.delete(); 
    return;
  }
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
      }
    }
  });
});

app.use((error, _req, res, _next) => {
  console.error('Express error:', error.message);
  res.status(500).json({ error: 'Internal server error' });
});

// -----------------------------------------------------------------------------
// Start Server
// -----------------------------------------------------------------------------
const server = app.listen(ENV.PORT, () => {
  console.log(`🚀 VARAH WhatsApp Bot listening on port ${ENV.PORT}`);
});

function shutdown(signal) {
  console.log(`${signal} received; shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));