try { require('dotenv').config(); } catch (_) { }

const crypto = require('crypto');
const express = require('express');
const axios = require('axios');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const {
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  APP_SECRET,
  GRAPH_VERSION = 'v21.0',
  TICKET_PREFIX = 'SR',
  PORT = 3000,
} = process.env;

if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID || !VERIFY_TOKEN) {
  console.error('❌ .env mein WHATSAPP_TOKEN, PHONE_NUMBER_ID aur VERIFY_TOKEN zaroori hain');
  process.exit(1);
}

// ==========================================
// 1. FIREBASE SETUP (Render & Local Dono Ke Liye)
// ==========================================
let serviceAccount;
if (process.env.FIREBASE_CREDENTIALS) {
  serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
} else {
  serviceAccount = require('./serviceAccountKey.json');
}
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// 🔥 REQUEST LOGGER: Har request terminal mein dikhegi
app.use((req, res, next) => {
  console.log(`\n➡️  ${req.method} ${req.originalUrl}`);
  if (req.method === 'POST') {
    console.log('📦 Webhook POST body aaya:', JSON.stringify(req.body, null, 2));
  }
  next();
});

app.get('/', (_req, res) => res.send('VARAH WhatsApp server OK'));

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified by Meta');
    return res.status(200).type('text/plain').send(String(challenge));
  }
  console.log('❌ Webhook verify fail (token mismatch ya galat mode)');
  res.sendStatus(403);
});

function validSignature(req) {
  if (!APP_SECRET) return true;
  const got = Buffer.from(req.get('x-hub-signature-256') || '');
  const want = Buffer.from('sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody || '').digest('hex'));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

app.post('/webhook', (req, res) => {
  if (!validSignature(req)) {
    console.log('❌ Signature galat - request ignore');
    return res.sendStatus(401);
  }
  res.sendStatus(200);

  const body = req.body || {};
  if (body.object !== 'whatsapp_business_account') return;

  (async () => {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const name = value.contacts && value.contacts[0] && value.contacts[0].profile ? value.contacts[0].profile.name : '';
        for (const message of value.messages || []) {
          try {
            await handleMessage(message, name);
          } catch (err) {
            console.error('❌ Message handle error:', err);
          }
        }
      }
    }
  })();
});

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

function textOf(m) {
  if (m.type === 'text' && m.text) return String(m.text.body || '').trim();
  if (m.type === 'button' && m.button) return String(m.button.text || '').trim();
  if (m.type === 'interactive' && m.interactive) {
    const r = m.interactive.button_reply || m.interactive.list_reply;
    return r ? String(r.title || r.id || '').trim() : '';
  }
  return '';
}

const MENU_TEXT = 'Namaste! Varah Technology mein aapka swagat hai.\n\nKaise madad karein?\n1. Sales Enquiry\n2. Service Request\n\nKripya 1 ya 2 likh kar bhejein.';

async function nextTicket() {
  const ref = db.collection('counters').doc('waLeads');
  const n = await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    const v = (s.exists ? s.data().n : 1000) + 1;
    t.set(ref, { n: v });
    return v;
  });
  return `${TICKET_PREFIX}-${n}`;
}

async function handleMessage(message, profileName) {
  const from = message.from;

  try {
    await db.collection('wa_processed').doc(message.id).create({ at: FieldValue.serverTimestamp(), from });
  } catch (e) {
    if (e.code === 6) { console.log('↩️ Duplicate message ignore:', message.id); return; }
    throw e;
  }

  const text = textOf(message);
  const low = text.toLowerCase();
  console.log(`📩 ${from} (${message.type}): ${text}`);

  const ref = db.collection('whatsapp_sessions').doc(from);
  const snap = await ref.get();
  let s = snap.exists ? snap.data() : null;
  if (s && s.updatedAt && Date.now() - s.updatedAt.toMillis() > SESSION_TTL_MS) s = null;

  if (!s || s.step === 'start' || low === 'menu' || low === '0') {
    await sendMessage(from, MENU_TEXT);
    await ref.set({ step: 'menu', updatedAt: FieldValue.serverTimestamp() });
    return;
  }

  if (s.step === 'menu') {
    if (low === '1' || low.startsWith('sales')) {
      await ref.set({ step: 'ask_details', type: 'sales', updatedAt: FieldValue.serverTimestamp() });
      await sendMessage(from, 'Aapne Sales Enquiry chuni hai. Kripya apna Naam aur requirement likh kar bhejein.');
    } else if (low === '2' || low.startsWith('service')) {
      await ref.set({ step: 'ask_details', type: 'service', updatedAt: FieldValue.serverTimestamp() });
      await sendMessage(from, 'Aapne Service Request chuni hai. Kripya apna Naam aur issue likh kar bhejein.');
    } else {
      await sendMessage(from, 'Kripya sahi option chunein. 1 ya 2 likhein.');
    }
    return;
  }

  if (s.step === 'ask_details') {
    if (!text) {
      await sendMessage(from, 'Kripya apni detail text mein likh kar bhejein.');
      return;
    }
    const ticketId = await nextTicket();
    await db.collection('leads').add({
      ticketId,
      phone: from,
      name: profileName || '',
      message: text,
      type: s.type || 'service',
      status: 'new',
      source: 'whatsapp',
      waMessageId: message.id,
      createdAt: FieldValue.serverTimestamp(),
    });
    await sendMessage(from, `Dhanyawad! Aapki request receive ho gayi hai.\n\nAapka Ticket Number: *${ticketId}*\n\nHamari team jald hi aapse sampark karegi.`);
    await ref.delete();
    console.log(`✅ Ticket saved: ${ticketId}`);
  }
}

async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    const d = error.response && error.response.data;
    console.error('❌ Message send fail:', d ? JSON.stringify(d) : error.message);
  }
}

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));