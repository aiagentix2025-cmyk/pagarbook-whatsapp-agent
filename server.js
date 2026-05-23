const express = require('express');
const { Client: PgClient } = require('pg');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// Serve Static Frontend files (Admin Dashboard) from public/ directory
app.use(express.static(path.join(__dirname, 'public')));

// Load credentials and configuration from environment variables
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'pagarbook_whatsapp_verify_token_2026';

// Google OAuth
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/oauth2callback";
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

// Database Configuration
const dbConfig = {
  host: process.env.PGHOST || '127.0.0.1',
  port: parseInt(process.env.PGPORT || '5432'),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'AGENTiX@2025',
  database: process.env.PGDATABASE || 'postgres',
};

// Paths
const PROMPT_FILE_PATH = process.env.PROMPT_FILE_PATH || path.join(__dirname, 'pagarbook system promt for agent.txt');

// Helper: Get PostgreSQL Client
async function getDbClient() {
  const client = new PgClient(dbConfig);
  await client.connect();
  return client;
}

// Helper: Fetch OpenAI Embeddings
async function getEmbedding(text) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not defined in environment variables.');
  }
  
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      input: text,
      model: 'text-embedding-3-small'
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI Embeddings error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  return result.data[0].embedding;
}

// Helper: Call OpenAI Chat Completion
async function getChatResponse(messages) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not defined in environment variables.');
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: messages,
      temperature: 0.3
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI Chat completion error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  return result.choices[0].message.content;
}

// Helper: Send WhatsApp Message
async function sendWhatsAppMessage(recipientPhone, textBody) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.error('WhatsApp credentials are not defined in environment variables.');
    return;
  }

  console.log(`Sending WhatsApp message to ${recipientPhone}: ${textBody}`);
  const url = `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: recipientPhone,
      type: 'text',
      text: { body: textBody }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`WhatsApp send error: ${response.status} - ${errText}`);
  }
}

// Helper: Initialize Google OAuth client
function getGoogleAuthClient() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error('Google OAuth credentials are not defined in environment variables.');
  }

  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
  oauth2Client.setCredentials({
    refresh_token: GOOGLE_REFRESH_TOKEN
  });
  return oauth2Client;
}

// ADMIN API: Get system stats
app.get('/api/stats', async (req, res) => {
  try {
    const db = await getDbClient();
    const docCountResult = await db.query('SELECT count(*) FROM public.documents');
    const conversationCountResult = await db.query('SELECT count(distinct session_id) FROM public.n8n_chat_histories');
    
    // Calculate uptime string
    const uptimeSeconds = Math.floor(process.uptime());
    const hrs = Math.floor(uptimeSeconds / 3600);
    const mins = Math.floor((uptimeSeconds % 3600) / 60);
    const secs = uptimeSeconds % 60;
    const uptimeStr = `${hrs}h ${mins}m ${secs}s`;

    res.json({
      totalDocuments: parseInt(docCountResult.rows[0].count),
      totalConversations: parseInt(conversationCountResult.rows[0].count),
      uptime: uptimeStr
    });
    await db.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ADMIN API: Get unique chat sessions
app.get('/api/sessions', async (req, res) => {
  try {
    const db = await getDbClient();
    const sessionsQuery = `
      SELECT session_id, count(*) as msg_count 
      FROM public.n8n_chat_histories 
      GROUP BY session_id 
      ORDER BY max(id) DESC
    `;
    const result = await db.query(sessionsQuery);
    res.json(result.rows);
    await db.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ADMIN API: Get messages for specific session
app.get('/api/sessions/:id', async (req, res) => {
  try {
    const db = await getDbClient();
    const result = await db.query(
      'SELECT id, message FROM public.n8n_chat_histories WHERE session_id = $1 ORDER BY id ASC',
      [req.params.id]
    );
    res.json(result.rows);
    await db.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ADMIN API: Test search semantic query playground
app.get('/api/search', async (req, res) => {
  const queryText = req.query.q;
  if (!queryText) {
    return res.status(400).json({ error: 'Query text required' });
  }

  try {
    const queryEmbedding = await getEmbedding(queryText);
    const vectorStr = `[${queryEmbedding.join(',')}]`;
    const db = await getDbClient();
    const result = await db.query(`
      SELECT content, metadata, 1 - (embedding <=> $1::extensions.vector) as similarity
      FROM public.documents
      ORDER BY embedding <=> $1::extensions.vector
      LIMIT 5
    `, [vectorStr]);
    
    res.json(result.rows);
    await db.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Meta Webhook Verification (GET /webhook)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Webhook verified successfully!');
      return res.status(200).send(challenge);
    } else {
      console.warn('Webhook verification token mismatch.');
      return res.sendStatus(403);
    }
  }
  return res.sendStatus(400);
});

// Meta Message Handler (POST /webhook)
app.post('/webhook', async (req, res) => {
  // Acknowledge the receipt of event immediately to Meta to avoid timeout retries
  res.status(200).send('EVENT_RECEIVED');

  try {
    const entry = req.body.entry;
    if (!entry || !entry[0]?.changes?.[0]?.value?.messages?.[0]) {
      return;
    }

    const messageObj = entry[0].changes[0].value.messages[0];
    if (messageObj.type !== 'text') {
      return;
    }

    const recipientPhone = messageObj.from;
    const userMessage = messageObj.text.body;
    const profileName = entry[0].changes[0].value.contacts?.[0]?.profile?.name || 'Customer';

    console.log(`Received message from ${profileName} (${recipientPhone}): "${userMessage}"`);

    // 1. Calculate Session ID (matches n8n daily session key)
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const sessionId = `${recipientPhone}_${todayStr}`;

    const db = await getDbClient();

    // 2. Retrieve history for this daily session
    const historyQuery = `
      SELECT message FROM public.n8n_chat_histories 
      WHERE session_id = $1 
      ORDER BY id ASC
    `;
    const historyResult = await db.query(historyQuery, [sessionId]);
    const history = historyResult.rows;

    // 3. Check if this is the start of a new conversation (no prior messages in the daily session)
    if (history.length === 0) {
      console.log(`New session detected for ${sessionId}. Sending mandatory intro message.`);

      const mandatoryIntro = `Hi, I'm Puja Sharma 🙂\nI help businesses manage staff attendance, payroll/salary calculation, employee records, and workforce tracking with PagarBook.\nHow can I assist you today?`;

      // Save user message in history
      const saveUserMsgQuery = `
        INSERT INTO public.n8n_chat_histories (session_id, message) 
        VALUES ($1, $2)
      `;
      await db.query(saveUserMsgQuery, [sessionId, JSON.stringify({ type: 'human', content: userMessage })]);

      // Save bot intro message in history
      await db.query(saveUserMsgQuery, [sessionId, JSON.stringify({ type: 'ai', content: mandatoryIntro })]);

      // Send to WhatsApp
      await sendWhatsAppMessage(recipientPhone, mandatoryIntro);
      await db.end();
      return;
    }

    // Save current user message in database history before processing response
    const saveUserMsgQuery = `
      INSERT INTO public.n8n_chat_histories (session_id, message) 
      VALUES ($1, $2)
    `;
    await db.query(saveUserMsgQuery, [sessionId, JSON.stringify({ type: 'human', content: userMessage })]);

    // 4. Query pgvector for semantic search (Retrieval)
    let contextText = '';
    try {
      const userEmbedding = await getEmbedding(userMessage);
      const vectorStr = `[${userEmbedding.join(',')}]`;
      
      const similarityQuery = `
        SELECT content, metadata, 1 - (embedding <=> $1::extensions.vector) as similarity
        FROM public.documents
        ORDER BY embedding <=> $1::extensions.vector
        LIMIT 4
      `;
      const similarityResult = await db.query(similarityQuery, [vectorStr]);
      
      contextText = similarityResult.rows
        .map(row => `- ${row.content}`)
        .join('\n\n');
      console.log(`Retrieved ${similarityResult.rows.length} relevant context chunks from DB.`);
    } catch (dbErr) {
      console.error('Error querying vector store:', dbErr);
    }

    // 5. Construct OpenAI prompt
    // Read the Pagarbook system prompt file
    let systemPromptBase = '';
    try {
      systemPromptBase = fs.readFileSync(PROMPT_FILE_PATH, 'utf8');
    } catch (fsErr) {
      console.error('Error reading system prompt file. Using fallback.', fsErr);
      systemPromptBase = 'You are Puja Sharma, a workforce consultant for PagarBook.';
    }

    // Format dynamic dates in IST
    const todayDateIST = now.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' });
    const todayWeekdayIST = now.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'long' });
    
    const promptHeader = `Today's date in IST is ${todayDateIST}, and today's weekday is ${todayWeekdayIST}.\n\n`;
    const promptContext = `Official Knowledge Base Context:\n${contextText}\n\n`;
    
    const finalSystemPrompt = promptHeader + promptContext + systemPromptBase;

    // Build message history array for OpenAI
    const openAiMessages = [
      { role: 'system', content: finalSystemPrompt }
    ];

    // Append prior history
    history.forEach(row => {
      const msg = row.message;
      const role = msg.type === 'human' ? 'user' : 'assistant';
      openAiMessages.push({ role, content: msg.content });
    });

    // Append current user message
    openAiMessages.push({ role: 'user', content: userMessage });

    // 6. Generate reply from OpenAI
    console.log('Sending message context to OpenAI...');
    const botResponse = await getChatResponse(openAiMessages);
    console.log(`OpenAI response: "${botResponse}"`);

    // 7. Save Bot response to database
    await db.query(saveUserMsgQuery, [sessionId, JSON.stringify({ type: 'ai', content: botResponse })]);

    // 8. Split responses by [SEND] if necessary and send to WhatsApp
    let messagesToSend = [botResponse];
    if (botResponse.includes('[SEND]')) {
      messagesToSend = botResponse
        .split('[SEND]')
        .map(msg => msg.trim())
        .filter(msg => msg.length > 0);
    }

    for (const msg of messagesToSend) {
      await sendWhatsAppMessage(recipientPhone, msg);
      // Brief delay between sending messages for conversational effect
      await new Promise(r => setTimeout(r, 1000));
    }

    // 9. Booking Confirmation Logic
    if (botResponse.toLowerCase().includes('[booking_confirmed]')) {
      console.log('Booking confirmed detected! Initializing Google Calendar + Email booking...');
      
      try {
        // Extract Name
        const nameMatch = botResponse.match(/Name:\s*([^,\n]+)/i);
        const customerName = nameMatch ? nameMatch[1].trim() : profileName;

        // Extract Mobile
        const mobileMatch = botResponse.match(/(?:Mobile|Phone):\s*(\d+)/i);
        const mobile = mobileMatch ? mobileMatch[1].trim() : recipientPhone;

        // Extract Email
        const emailMatch = botResponse.match(/Email:\s*([^\s,\n]+@[^\s,\n]+)/i);
        const email = emailMatch ? emailMatch[1].trim() : '';

        // Extract Business Name
        const businessMatch = botResponse.match(/(?:Business Name|Business):\s*([^,\n]+)/i);
        const businessName = businessMatch ? businessMatch[1].trim() : 'Unknown';

        // Extract Staff Count
        const staffMatch = botResponse.match(/(?:Staff Count|Staff):\s*(\d+)/i);
        const staffCount = staffMatch ? staffMatch[1].trim() : 'Unknown';

        // Parse Date/Time
        const dateTimeMatch = botResponse.match(/on\s+(?:\w+,\s+)?(\d{1,2}\s+\w+\s+\d{4})\s+at\s+(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
        
        let startISO = '';
        let endISO = '';

        if (dateTimeMatch) {
          const combined = dateTimeMatch[1] + ' ' + dateTimeMatch[2];
          // Parse in IST (+05:30)
          const parsedDate = new Date(combined + ' +0530');
          if (!isNaN(parsedDate.getTime())) {
            startISO = parsedDate.toISOString();
            endISO = new Date(parsedDate.getTime() + 30 * 60 * 1000).toISOString(); // 30 minutes duration
          }
        }

        if (startISO && endISO) {
          const eventDetails = {
            name: customerName,
            mobile,
            email,
            businessName,
            staffCount,
            startISO,
            endISO
          };

          const authClient = getGoogleAuthClient();
          const calendar = google.calendar({ version: 'v3', auth: authClient });

          // Create Google Calendar event
          console.log(`Scheduling Calendar Event for ${customerName}...`);
          const calendarResponse = await calendar.events.insert({
            calendarId: 'primary',
            resource: {
              summary: `PagarBook Live Demo - ${customerName} (${businessName})`,
              description: `Customer Name: ${customerName}\nBusiness Name: ${businessName}\nStaff Count: ${staffCount}\nMobile: ${mobile}\nEmail: ${email}\nBooked via WhatsApp AI Bot`,
              start: { dateTime: startISO, timeZone: 'Asia/Kolkata' },
              end: { dateTime: endISO, timeZone: 'Asia/Kolkata' },
              attendees: email ? [{ email: email }] : [],
              reminders: {
                useDefault: false,
                overrides: [
                  { method: 'email', minutes: 60 },
                  { method: 'popup', minutes: 30 },
                ],
              },
            },
            sendUpdates: 'all'
          });

          const htmlLink = calendarResponse.data.htmlLink;
          console.log(`Calendar event created successfully. Link: ${htmlLink}`);

          // Send confirmation email via Gmail (if email provided)
          if (email) {
            console.log(`Sending Gmail confirmation to ${email}...`);
            const gmail = google.gmail({ version: 'v1', auth: authClient });
            
            const formattedDate = new Date(startISO).toLocaleString("en-IN", {
              timeZone: "Asia/Kolkata",
              dateStyle: "full",
              timeStyle: "short"
            });

            const htmlBody = `
            <html>
            <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
              <div style="max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
                <h2 style="color: #1e3a8a; border-bottom: 2px solid #1e3a8a; padding-bottom: 10px;">
                  PagarBook Live Demo Confirmed
                </h2>
                <p>Dear ${customerName},</p>
                <p>Your live interactive demo for <strong>PagarBook</strong> staff and payroll automation has been scheduled successfully.</p>
                <div style="background-color: #f3f4f6; padding: 15px; border-left: 4px solid #1e3a8a; margin: 20px 0;">
                  <p style="margin: 5px 0;"><strong>Company:</strong> ${businessName}</p>
                  <p style="margin: 5px 0;"><strong>Staff Count:</strong> ${staffCount}</p>
                  <p style="margin: 5px 0;"><strong>Date & Time:</strong> ${formattedDate} (IST)</p>
                  <p style="margin: 5px 0;"><strong>Type:</strong> Online Live Demo</p>
                </div>
                <p style="margin: 20px 0;">
                  <a href="${htmlLink}" style="display: inline-block; background-color: #1e3a8a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold;">Add to Google Calendar</a>
                </p>
                <p style="font-size: 14px; color: #666; margin-top: 30px; padding-top: 15px; border-top: 1px solid #e0e0e0;">
                  Our team will contact you on WhatsApp / Phone at ${mobile} to start the demo.
                </p>
              </div>
            </body>
            </html>
            `;

            const subject = `PagarBook Demo Confirmed | ${businessName}`;
            const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
            const messageParts = [
              `To: ${email}`,
              'Content-Type: text/html; charset=utf-8',
              'MIME-Version: 1.0',
              `Subject: ${utf8Subject}`,
              '',
              htmlBody
            ];
            const raw = Buffer.from(messageParts.join('\n'))
              .toString('base64')
              .replace(/\+/g, '-')
              .replace(/\//g, '_')
              .replace(/=+$/, '');

            await gmail.users.messages.send({
              userId: 'me',
              resource: { raw }
            });
            console.log(`Confirmation email sent successfully.`);
          }

          // Send confirmation details back via WhatsApp
          const whatsappConfirmMessage = `Your demo slot has been blocked on our calendar!\n\nView your booking here:\n${htmlLink}\n\n` +
            (email ? `A confirmation email has been sent to ${email}.\n\n` : '') +
            `This link also works as a reminder before your visit. See you in the live demo!`;
            
          await sendWhatsAppMessage(recipientPhone, whatsappConfirmMessage);
        } else {
          console.warn('Could not parse start/end ISO from response:', botResponse);
        }
      } catch (bookingErr) {
        console.error('Error during calendar/email booking logic:', bookingErr);
      }
    }

    await db.end();
  } catch (err) {
    console.error('Error handling request:', err);
  }
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`Pagarbook WhatsApp AI Agent listening on port ${PORT}`);
});
