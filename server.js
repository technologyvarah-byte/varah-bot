// 1. Menu Text Update (Pure Professional)
const MENU_TEXT = 
  `Welcome to *VARAH TECHNOLOGY*.\n` +
  `Premium CCTV & Security Solutions.\n\n` +
  `How may we assist you today?\n\n` +
  `*1.* New CCTV Installation & Sales\n` +
  `*2.* Repair & Technical Service\n` +
  `*3.* Check Existing Ticket Status\n` +
  `*4.* Product Quotation & Pricing\n` +
  `*5.* Speak to a Support Agent\n\n` +
  `Please reply with a number (1-5). Type *MENU* anytime to return.`;

// 2. Handle Message Logic
async function handleMessage(message, profileName) {
  const from = normalizePhone(message.from);
  if (!from || !message.id) return;

  // Atomic idempotency
  const processedRef = db.collection('wa_processed').doc(message.id);
  try {
    await processedRef.create({ at: now(), from });
  } catch (error) {
    if (error.code === 6 || error.code === 'already-exists') return;
    throw error;
  }

  const text = textOf(message);
  const low = text.toLowerCase().trim();
  
  const sessionRef = db.collection('whatsapp_sessions').doc(from);
  const sessionSnap = await sessionRef.get();
  let session = sessionSnap.exists ? sessionSnap.data() : null;
  if (session?.updatedAt?.toMillis && Date.now() - session.updatedAt.toMillis() > ENV.SESSION_TTL_MS) {
    session = null;
    await sessionRef.delete().catch(() => {});
  }

  // Greeting & Main Menu
  if (isMenu(low) || isGreeting(low) || !session) {
    await updateSession(sessionRef, { step: 'menu', type: null, collected: {} });
    await safeSend(from, MENU_TEXT);
    return;
  }

  // Human Handoff
  if (isHuman(low) || low === '5') {
    await db.collection('wa_handoffs').add({
      phone: from, name: clean(profileName, 120), status: 'open', source: 'whatsapp', createdAt: now(),
    });
    await safeSend(from, 
      `Your request has been forwarded to our support team. ✅\n` +
      `A representative will contact you shortly.\n\n` +
      `Type *MENU* to return to the main menu.`
    );
    await sessionRef.delete();
    return;
  }

  // Menu Selections
  if (session.step === 'menu') {
    if (low === '3') {
      await updateSession(sessionRef, { step: 'ticket_status' });
      await safeSend(from, `Please provide your *Ticket ID* to check the status.\n(Example: VT-1001)`);
      return;
    }
    
    if (['1', '2', '4'].includes(low)) {
      const type = (low === '1' || low === '4') ? 'sales' : 'service';
      await updateSession(sessionRef, { step: 'ask_details', type, category: low });
      
      const prompt = low === '1' ? `Please provide your *Name*, *City*, and the *Number of Cameras* required.` :
                     low === '2' ? `Please provide your *Name*, *Location*, and a brief description of the *Issue*.` :
                                   `Please provide your *Name*, *Location*, and your specific *Pricing Requirement*.`;
      
      await safeSend(from, prompt);
      return;
    }
    
    await safeSend(from, `Invalid selection. Please reply with a number from 1 to 5.`);
    return;
  }

  // Check Ticket Status
  if (session.step === 'ticket_status') {
    const ticket = await findTicket(text, from);
    if (!ticket) {
      await safeSend(from, `We could not find a ticket with this ID associated to your number.\n\nPlease verify the Ticket ID or type *MENU* to return.`);
      return;
    }
    await safeSend(from,
      `🎫 *Ticket ID:* ${ticket.ticketId}\n` +
      `*Status:* ${clean(ticket.status || 'new', 40).toUpperCase()}\n` +
      `*Service Type:* ${ticket.type === 'sales' ? 'Sales & Installation' : 'Technical Service'}\n\n` +
      `Our team is reviewing your request.`
    );
    await setMenu(from, sessionRef);
    return;
  }

  // Collect Details & Validate (No 'Hi' allowed as details)
  if (session.step === 'ask_details') {
    const invalidKeywords = ['hi', 'hello', 'hey', 'ok', 'yes', 'no'];
    
    if (!text || text.length < 8 || invalidKeywords.includes(low) || isGreeting(low)) {
      await safeSend(from, 
        `We were unable to process your request as the details provided are incomplete.\n\n` +
        `Please provide your *Name*, *Location*, and *Requirement* in a single message.\n` +
        `_(Example: Rahul Sharma - Jaipur - Need 4 outdoor cameras)_`
      );
      return; 
    }

    const ticketId = await nextTicket(session.type || 'service');
    
    await db.collection('leads').add({
      ticketId,
      phone: from,
      name: clean(profileName, 120),
      message: clean(text, 3000),
      type: session.type || 'service',
      status: 'new',
      source: 'whatsapp',
      category: session.category,
      createdAt: now(),
      updatedAt: now(),
    });
    
    await safeSend(from, 
      `Thank you, ${clean(profileName, 80) || 'Customer'}. ✅\n\n` +
      `Your request has been successfully registered in our system.\n` +
      `🎫 *Reference ID:* ${ticketId}\n\n` +
      `A dedicated representative from VARAH TECHNOLOGY will contact you shortly.\n\n` +
      `Type *MENU* for any further assistance.`
    );
    
    await sessionRef.delete(); 
    return;
  }
}