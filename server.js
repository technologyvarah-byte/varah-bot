try { require('dotenv').config(); } catch (_) { }

const crypto = require('crypto');
const express = require('express');
const axios = require('axios');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// ==========================================
// ⚙️ ENVIRONMENT VARIABLES
// ==========================================
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
// 🔥 1. FIREBASE SETUP (Render & Local)
// ==========================================
let serviceAccount;

// Agar Render par hain (Environment Variable set hai)
if (process.env.FIREBASE_CREDENTIALS) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
  } catch (error) {
    console.error("❌ FIREBASE_CREDENTIALS parse error:", error);
    process.exit(1);
  }
} else {
  // Agar local laptop par hain (File se read karein)
  try {
    serviceAccount = require('./serviceAccountKey.json');
  } catch (error) {
    console.error("❌ Local 'serviceAccountKey.json' file nahi mili!");
    process.exit(1);
  }
}

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// 🔥 REQUEST LOGGER
app.use((req, res, next) => {
  console.log(`\n➡️  ${req.method} ${req.originalUrl}`);
  if (req.method === 'POST') {
    console.log('📦 Webhook POST body aaya:', JSON.stringify(req.body, null, 2));
  }
  next();
});

app.get('/', (_req, res) => res.send('Varah CCTV Bot Server is Running OK ✅'));

// ==========================================
// 🔗 WEBHOOK VERIFICATION (GET)
// ==========================================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified by Meta');
    return res.status(200).type('text/plain').send(String(challenge));
  }
  console.log('❌ Webhook verify fail');
  res.sendStatus(403);
});

// ==========================================
// 🔒 SECURITY CHECK
// ==========================================
function validSignature(req) {
  if (!APP_SECRET) return true;
  const got = Buffer.from(req.get('x-hub-signature-256') || '');
  const want = Buffer.from('sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody || '').digest('hex'));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ==========================================
// 📩 RECEIVE MESSAGES (POST)
// ==========================================
app.post('/webhook', (req, res) => {
  if (!validSignature(req)) {
    console.log('❌ Signature galat - request ignore');
    return res.sendStatus(401);
  }
  
  // Meta ko turant 200 OK (Render timeout se bachne ke liye)
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

// ==========================================
// 🧠 BOT LOGIC & STATE MANAGEMENT
// ==========================================
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours session expiry

function textOf(m) {
  if (m.type === 'text' && m.text) return String(m.text.body || '').trim();
  if (m.type === 'button' && m.button) return String(m.button.text || '').trim();
  if (m.type === 'interactive' && m.interactive) {
    const r = m.interactive.button_reply || m.interactive.list_reply;
    return r ? String(r.title || r.id || '').trim() : '';
  }
  return '';
}

const MENU_TEXT = 'Namaste! *Varah Technology (CCTV Solutions)* mein aapka swagat hai. 🙏\n\nKaise madad karein?\n*1.* Naya CCTV Setup / Sales\n*2.* CCTV Repair / Service Request\n\nKripya *1* ya *2* likh kar bhejein.';

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

  // Duplicate message check
  try {
    await db.collection('wa_processed').doc(message.id).create({ at: FieldValue.serverTimestamp(), from });
  } catch (e) {
    if (e.code === 6) { console.log('↩️ Duplicate message ignore:', message.id); return; }
    throw e;
  }

  const text = textOf(message);
  const low = text.toLowerCase().trim();
  console.log(`📩 ${from} (${message.type}): ${text}`);

  const ref = db.collection('whatsapp_sessions').doc(from);
  const snap = await ref.get();
  let s = snap.exists ? snap.data() : null;
  if (s && s.updatedAt && Date.now() - s.updatedAt.toMillis() > SESSION_TTL_MS) s = null;

  // 1. Initial Greeting / Reset / Menu
  if (!s || s.step === 'start' || low === 'menu' || low === '0' || low === 'hi' || low === 'hello') {
    await sendMessage(from, MENU_TEXT);
    await ref.set({ step: 'menu', updatedAt: FieldValue.serverTimestamp() });
    return;
  }

  // 2. Menu Selection
  if (s.step === 'menu') {
    if (low === '1' || low.startsWith('sales')) {
      await ref.set({ step: 'ask_details', type: 'sales', updatedAt: FieldValue.serverTimestamp() });
      await sendMessage(from, 'Aapne *Naya CCTV Setup / Sales* chuna hai. 🛒\n\nKripya apna *Naam, City, aur Kitne Camera* chahiye (approx) likh kar bhejein.\n\n_(Udaharan: Rahul Sharma - Noida - 4 Camera lagwane hain)_');
    } else if (low === '2' || low.startsWith('service')) {
      await ref.set({ step: 'ask_details', type: 'service', updatedAt: FieldValue.serverTimestamp() });
      await sendMessage(from, 'Aapne *CCTV Repair / Service* chuna hai. 🛠️\n\nKripya apna *Naam, Location, aur Problem* short mein likh kar bhejein.\n\n_(Udaharan: Amit - Andheri - DVR on nahi ho raha)_');
    } else {
      await sendMessage(from, 'Kshama kijiye, main samajh nahi paaya.\nKripya sahi option chunein. *1* ya *2* likhein.');
    }
    return;
  }

  // 3. Detail Collection & Validation
  if (s.step === 'ask_details') {
    // 🚨 VALIDATION (Hi/Hello/Chote messages ko block karne ke liye)
    const invalidKeywords = ['hi', 'hello', 'hey', 'hii', 'ok', 'hmm', '1', '2'];
    
    if (!text || text.length < 5 || invalidKeywords.includes(low)) {
      await sendMessage(from, `Kshama kijiye, main aapki details samajh nahi paaya. 😔\n\nKripya apna *Naam, City aur Requirement* ek sath likh kar bhejein.\n\n_(Udaharan: Vikas - Delhi - 2 Camera kharab hain)_`);
      return; // Yahan return kar diya, taaki ticket generate na ho
    }

    // Agar details sahi hain, toh Ticket generate karo
    const ticketId = await nextTicket();
    
    // Save to Firebase Firestore
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
    
    // Send Ticket Confirmation
    await sendMessage(from, `Dhanyawad ${profileName ? profileName : ''}! Aapki request safaltapoorvak darj kar li gayi hai. ✅\n\n🎫 Aapka Ticket Number: *${ticketId}*\n\nHamari team jald hi aapse sampark karegi. Kisi anya sahayata ke liye *Menu* likhein.`);
    
    // Session clear karo taaki next time naya flow chale
    await ref.delete(); 
    console.log(`✅ Ticket saved in DB: ${ticketId}`);
  }
}

// ==========================================
// 📤 SEND MESSAGE HELPER
// ==========================================
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

// ==========================================
// 🚀 START SERVER
// ==========================================
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));