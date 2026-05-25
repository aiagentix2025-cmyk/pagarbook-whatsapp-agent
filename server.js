const express = require('express');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { createClient } = require('redis');

// Import Platform Modules
const db = require('./db');
const queue = require('./queue');
const docs = require('./docs');
const llm = require('./llm');
const media = require('./media');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve Static Frontend files from public/ directory
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(path.join(__dirname, 'public', 'media')));

// Load central configuration
const PORT = process.env.PORT || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/oauth2callback";
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

// Initialize Redis Client for Deduplication
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const redisClient = createClient({ url: redisUrl });
redisClient.on('error', err => console.error('Redis Client Error:', err));

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

// Helper: Send WhatsApp Message (Meta API)
async function sendWhatsAppMessage(recipientPhone, textBody, accessToken, phoneNumberId, type = 'text', mediaUrl = null, filename = null, buttons = null) {
  if (!accessToken || !phoneNumberId) {
    console.error('Meta credentials missing. Cannot send message.');
    return;
  }

  console.log(`Sending WhatsApp message of type ${type} via Meta to ${recipientPhone}`);
  const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
  
  let bodyPayload = {
    messaging_product: 'whatsapp',
    to: recipientPhone
  };

  if (type === 'image') {
    bodyPayload.type = 'image';
    bodyPayload.image = { link: mediaUrl || textBody };
  } else if (type === 'document') {
    bodyPayload.type = 'document';
    bodyPayload.document = { link: mediaUrl || textBody, filename: filename || 'document.pdf' };
  } else if (type === 'interactive' && buttons && buttons.length > 0) {
    bodyPayload.type = 'interactive';
    bodyPayload.interactive = {
      type: 'button',
      body: { text: textBody },
      action: {
        buttons: buttons.map((btn, idx) => ({
          type: 'reply',
          reply: { id: btn.id || `btn_${idx}`, title: btn.title }
        }))
      }
    };
  } else {
    bodyPayload.type = 'text';
    bodyPayload.text = { body: textBody };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(bodyPayload)
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`WhatsApp send error: ${response.status} - ${errText}`);
    throw new Error(errText);
  }
}

// Helper: Free DuckDuckGo Web Search crawler
async function searchWeb(query) {
  try {
    console.log(`Executing web search tool for query: "${query}"...`);
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (!res.ok) return `Web search error: ${res.status} ${res.statusText}`;
    const html = await res.text();
    const snippets = [];
    // Extract search snippets
    const regex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let match;
    while ((match = regex.exec(html)) !== null && snippets.length < 5) {
      const cleanSnippet = match[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      snippets.push(cleanSnippet);
    }
    return snippets.join('\n\n') || "No web search results found.";
  } catch (err) {
    console.error('Web search failed:', err);
    return `Search failed: ${err.message}`;
  }
}

// -------------------------------------------------------------
// ADMIN MANAGEMENT APIS
// -------------------------------------------------------------

// Onboard Client: Register in central DB & dynamically provision isolated PostgreSQL database
app.post('/api/clients', async (req, res) => {
  const { 
    name, 
    phone_number_id, 
    whatsapp_business_id, 
    app_id, 
    app_secret, 
    system_access_token, 
    webhook_verify_token 
  } = req.body;

  if (!name || !phone_number_id || !whatsapp_business_id || !app_id || !app_secret || !system_access_token || !webhook_verify_token) {
    return res.status(400).json({ error: 'All onboarding credentials are required.' });
  }

  try {
    const dbName = await db.createTenantDatabase(
      name, 
      phone_number_id, 
      whatsapp_business_id, 
      app_id, 
      app_secret, 
      system_access_token, 
      webhook_verify_token
    );
    res.json({ message: `Client onboarded and database ${dbName} created successfully.`, db_name: dbName });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Onboarding failed: ' + err.message });
  }
});

// Toggle Client Listening State
app.post('/api/clients/:phoneId/toggle', async (req, res) => {
  const { phoneId } = req.params;
  const { is_listening } = req.body;

  try {
    const centralClient = await db.getCentralClient();
    await centralClient.query(
      'UPDATE public.clients SET is_listening = $1 WHERE phone_number_id = $2',
      [is_listening === true, phoneId]
    );
    centralClient.release();
    res.json({ message: `Listening state updated to ${is_listening === true}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create and Enqueue a Bulk Template Campaign
app.post('/api/campaigns', async (req, res) => {
  const { client_id, name, template_name, language_code, recipients, components } = req.body;

  if (!client_id || !name || !template_name || !recipients || !Array.isArray(recipients)) {
    return res.status(400).json({ error: 'Client ID, name, template name, and recipients list are required.' });
  }

  try {
    const centralClient = await db.getCentralClient();
    const clientRes = await centralClient.query('SELECT * FROM public.clients WHERE id = $1', [client_id]);
    centralClient.release();

    if (clientRes.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found.' });
    }

    const client = clientRes.rows[0];
    const tenantPool = db.getTenantPool(client.db_name);

    // Create Campaign Record
    const campRes = await tenantPool.query(
      `INSERT INTO public.campaigns (name, template_name, language_code, total_recipients, status) 
       VALUES ($1, $2, $3, $4, 'draft') RETURNING id`,
      [name, template_name, language_code || 'en', recipients.length]
    );
    const campaignId = campRes.rows[0].id;

    // Dispatch to BullMQ Queue
    await queue.enqueueCampaign(client, campaignId, template_name, language_code, recipients, components);

    res.json({ message: 'Campaign enqueued successfully.', campaign_id: campaignId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to enqueue campaign: ' + err.message });
  }
});

// GET Campaigns List with Stats
app.get('/api/campaigns', async (req, res) => {
  const { client_id } = req.query;
  if (!client_id) return res.status(400).json({ error: 'client_id required' });

  try {
    const centralClient = await db.getCentralClient();
    const clientRes = await centralClient.query('SELECT db_name FROM public.clients WHERE id = $1', [client_id]);
    centralClient.release();

    if (!clientRes.rows.length) return res.status(404).json({ error: 'Client not found' });
    const tenantPool = db.getTenantPool(clientRes.rows[0].db_name);

    const result = await tenantPool.query(`
      SELECT c.*, 
             COUNT(l.id) as total_logs,
             SUM(CASE WHEN l.status = 'queued' THEN 1 ELSE 0 END) as queued_count,
             SUM(CASE WHEN l.status = 'sent' THEN 1 ELSE 0 END) as sent_count,
             SUM(CASE WHEN l.status = 'delivered' THEN 1 ELSE 0 END) as delivered_count,
             SUM(CASE WHEN l.status = 'read' THEN 1 ELSE 0 END) as read_count,
             SUM(CASE WHEN l.status = 'failed' THEN 1 ELSE 0 END) as failed_count
      FROM public.campaigns c
      LEFT JOIN public.campaign_logs l ON c.id = l.campaign_id
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload and Vectorize a Document
app.post('/api/documents', async (req, res) => {
  const { client_id, file_name, file_url, local_file_path } = req.body;

  if (!client_id || !file_name || !file_url || !local_file_path) {
    return res.status(400).json({ error: 'Client ID, file name, file URL, and local file path are required.' });
  }

  try {
    const centralClient = await db.getCentralClient();
    const clientRes = await centralClient.query('SELECT db_name FROM public.clients WHERE id = $1', [client_id]);
    centralClient.release();

    if (clientRes.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found.' });
    }

    const client = clientRes.rows[0];
    
    // Asynchronously ingest document into the client's vector DB
    docs.ingestDocument(client.db_name, file_name, file_url, local_file_path, process.env.OPENAI_API_KEY)
      .then(() => console.log(`Ingested ${file_name}`))
      .catch(err => console.error(`Error ingesting ${file_name}:`, err));

    res.json({ message: 'Document ingestion started.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Direct Base64 File Upload & Ingestion
app.post('/api/upload', async (req, res) => {
  const { client_id, file_name, file_data } = req.body;

  if (!client_id || !file_name || !file_data) {
    return res.status(400).json({ error: 'Client ID, file name, and file data (base64) are required.' });
  }

  try {
    const centralClient = await db.getCentralClient();
    const clientRes = await centralClient.query('SELECT db_name FROM public.clients WHERE id = $1', [client_id]);
    centralClient.release();

    if (clientRes.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found.' });
    }

    const client = clientRes.rows[0];
    const uploadDir = path.join(__dirname, 'public', 'media');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const localFilePath = path.join(uploadDir, file_name);
    const buffer = Buffer.from(file_data, 'base64');
    fs.writeFileSync(localFilePath, buffer);

    const fileUrl = `${req.protocol}://${req.get('host')}/media/${file_name}`;

    // Asynchronously ingest document into pgvector
    docs.ingestDocument(client.db_name, file_name, fileUrl, localFilePath, process.env.OPENAI_API_KEY)
      .then(() => {
        console.log(`Successfully ingested and vectorized: ${file_name}`);
      })
      .catch(err => {
        console.error(`Failed vectorizing document ${file_name}:`, err);
      });

    res.json({ message: 'Upload successful, vectorizing in background.', file_url: fileUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET List of Clients
app.get('/api/clients', async (req, res) => {
  try {
    const centralClient = await db.getCentralClient();
    const result = await centralClient.query('SELECT id, name, db_name, phone_number_id, is_listening FROM public.clients ORDER BY name ASC');
    centralClient.release();
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET Approved Meta WhatsApp Templates for a client
app.get('/api/templates', async (req, res) => {
  const { client_id } = req.query;
  if (!client_id) return res.status(400).json({ error: 'client_id required' });

  try {
    const centralClient = await db.getCentralClient();
    const clientRes = await centralClient.query(
      'SELECT whatsapp_business_id, system_access_token FROM public.clients WHERE id = $1',
      [client_id]
    );
    centralClient.release();

    if (!clientRes.rows.length) return res.status(404).json({ error: 'Client not found' });

    const { whatsapp_business_id, system_access_token } = clientRes.rows[0];

    const metaUrl = `https://graph.facebook.com/v18.0/${whatsapp_business_id}/message_templates` +
      `?fields=name,status,language,category,components&limit=100&access_token=${system_access_token}`;

    const metaRes = await fetch(metaUrl);
    const metaData = await metaRes.json();

    if (!metaRes.ok) {
      console.error('Meta templates API error:', metaData);
      return res.status(metaRes.status).json({ error: metaData.error?.message || 'Meta API error' });
    }

    // Return all templates (including APPROVED ones); client can filter
    const templates = (metaData.data || []);
    res.json(templates);
  } catch (err) {
    console.error('Error fetching templates:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET Client Stats
app.get('/api/stats', async (req, res) => {
  const { client_id } = req.query;
  if (!client_id) return res.status(400).json({ error: 'client_id parameter is required' });

  try {
    const centralClient = await db.getCentralClient();
    const clientRes = await centralClient.query('SELECT db_name FROM public.clients WHERE id = $1', [client_id]);
    centralClient.release();

    if (clientRes.rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    const dbName = clientRes.rows[0].db_name;
    const tenantPool = db.getTenantPool(dbName);

    const docCount = await tenantPool.query('SELECT count(*) FROM public.kb_documents');
    const totalConversations = await tenantPool.query('SELECT count(*) FROM public.chat_sessions');
    const activeChats = await tenantPool.query("SELECT count(*) FROM public.chat_sessions WHERE session_status = 'active'");
    const pausedChats = await tenantPool.query("SELECT count(*) FROM public.chat_sessions WHERE session_status = 'paused'");
    const totalCampaigns = await tenantPool.query('SELECT count(*) FROM public.campaigns');

    // Campaign Logs delivery stats
    const logStats = await tenantPool.query(`
      SELECT 
        COALESCE(SUM(CASE WHEN status != 'failed' THEN 1 ELSE 0 END), 0) as success_count,
        COALESCE(COUNT(*), 0) as total_count
      FROM public.campaign_logs
    `);

    const totalLogs = parseInt(logStats.rows[0].total_count);
    const successLogs = parseInt(logStats.rows[0].success_count);
    const deliveryRate = totalLogs > 0 ? Math.round((successLogs / totalLogs) * 100) : 100;

    const uptimeSeconds = Math.floor(process.uptime());
    const hrs = Math.floor(uptimeSeconds / 3600);
    const mins = Math.floor((uptimeSeconds % 3600) / 60);
    const uptimeStr = `${hrs}h ${mins}m`;

    res.json({
      totalDocuments: parseInt(docCount.rows[0].count),
      totalConversations: parseInt(totalConversations.rows[0].count),
      activeChats: parseInt(activeChats.rows[0].count),
      pausedChats: parseInt(pausedChats.rows[0].count),
      totalCampaigns: parseInt(totalCampaigns.rows[0].count),
      deliveryRate: deliveryRate + '%',
      uptime: uptimeStr
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET Client Sessions
app.get('/api/sessions', async (req, res) => {
  const { client_id } = req.query;
  if (!client_id) return res.status(400).json({ error: 'client_id parameter is required' });

  try {
    const centralClient = await db.getCentralClient();
    const clientRes = await centralClient.query('SELECT db_name FROM public.clients WHERE id = $1', [client_id]);
    centralClient.release();

    if (clientRes.rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    const dbName = clientRes.rows[0].db_name;
    const tenantPool = db.getTenantPool(dbName);

    const result = await tenantPool.query(`
      SELECT s.id as session_id, s.customer_phone, s.session_status, s.last_interaction, count(m.id) as msg_count
      FROM public.chat_sessions s
      LEFT JOIN public.chat_messages m ON m.session_id = s.id
      GROUP BY s.id
      ORDER BY s.last_interaction DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET Client Session Messages
app.get('/api/sessions/:id', async (req, res) => {
  const { client_id } = req.query;
  const sessionId = req.params.id;
  if (!client_id) return res.status(400).json({ error: 'client_id parameter is required' });

  try {
    const centralClient = await db.getCentralClient();
    const clientRes = await centralClient.query('SELECT db_name FROM public.clients WHERE id = $1', [client_id]);
    centralClient.release();

    if (clientRes.rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    const dbName = clientRes.rows[0].db_name;
    const tenantPool = db.getTenantPool(dbName);

    const result = await tenantPool.query(
      'SELECT id, sender_type, message_type, message_content, created_at FROM public.chat_messages WHERE session_id = $1 ORDER BY id ASC',
      [sessionId]
    );
    
    // Map to frontend compatibility format
    const formatted = result.rows.map(row => ({
      id: row.id,
      message: {
        type: row.sender_type === 'human' ? 'human' : 'ai',
        content: row.message_content
      }
    }));
    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET Vector Search Playground
app.get('/api/search', async (req, res) => {
  const { client_id, q } = req.query;
  if (!client_id || !q) return res.status(400).json({ error: 'client_id and q parameters are required' });

  try {
    const centralClient = await db.getCentralClient();
    const clientRes = await centralClient.query('SELECT db_name FROM public.clients WHERE id = $1', [client_id]);
    centralClient.release();

    if (clientRes.rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    const dbName = clientRes.rows[0].db_name;

    const rows = await docs.searchVectorKb(dbName, q, process.env.OPENAI_API_KEY, 5);
    
    // Map metadata format
    const formatted = rows.map(r => ({
      content: r.chunk_content,
      similarity: r.similarity,
      metadata: { source: r.file_name }
    }));
    
    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get system prompt or settings for AI Agent
app.get('/api/agents', async (req, res) => {
  const { client_id } = req.query;
  if (!client_id) {
    return res.status(400).json({ error: 'client_id parameter is required.' });
  }

  try {
    const centralClient = await db.getCentralClient();
    const result = await centralClient.query(
      'SELECT name, system_prompt, temperature, model_name FROM public.ai_agents WHERE client_id = $1',
      [client_id]
    );
    centralClient.release();

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'AI Agent settings not found for this client.' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Configure system prompts or settings for AI Agent
app.post('/api/agents', async (req, res) => {
  const { client_id, name, system_prompt, temperature, model_name } = req.body;
  if (!client_id || !name || !system_prompt) {
    return res.status(400).json({ error: 'Client ID, agent name, and system prompt are required.' });
  }

  try {
    const centralClient = await db.getCentralClient();
    await centralClient.query(`
      CREATE TABLE IF NOT EXISTS public.ai_agents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID UNIQUE NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        system_prompt TEXT NOT NULL,
        temperature NUMERIC(3,2) DEFAULT 0.3,
        model_name VARCHAR(100) DEFAULT 'gpt-4o-mini',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await centralClient.query(`
      INSERT INTO public.ai_agents (client_id, name, system_prompt, temperature, model_name)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (client_id) DO UPDATE SET
        name = EXCLUDED.name,
        system_prompt = EXCLUDED.system_prompt,
        temperature = EXCLUDED.temperature,
        model_name = EXCLUDED.model_name
    `, [client_id, name, system_prompt, temperature || 0.3, model_name || 'gpt-4o-mini']);
    
    centralClient.release();
    res.json({ message: 'AI Agent settings saved successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST: Send Manual operator Reply and Pause chatbot for 24h
app.post('/api/sessions/:id/reply', async (req, res) => {
  const { client_id, message, type, mediaUrl, filename, buttons } = req.body;
  const sessionId = req.params.id;
  if (!client_id || (!message && !mediaUrl)) {
    return res.status(400).json({ error: 'client_id and message/mediaUrl are required.' });
  }

  try {
    const centralClient = await db.getCentralClient();
    const clientRes = await centralClient.query(
      'SELECT db_name, phone_number_id, system_access_token FROM public.clients WHERE id = $1',
      [client_id]
    );
    centralClient.release();

    if (clientRes.rows.length === 0) return res.status(404).json({ error: 'Client not found.' });
    const { db_name, phone_number_id, system_access_token } = clientRes.rows[0];
    const tenantPool = db.getTenantPool(db_name);

    // Fetch session details (customer phone)
    const sessRes = await tenantPool.query('SELECT customer_phone FROM public.chat_sessions WHERE id = $1', [sessionId]);
    if (sessRes.rows.length === 0) return res.status(404).json({ error: 'Session not found.' });
    const customerPhone = sessRes.rows[0].customer_phone;

    // Send via Meta API
    await sendWhatsAppMessage(customerPhone, message || '', system_access_token, phone_number_id, type || 'text', mediaUrl, filename, buttons);

    // Save message to chat_messages
    const contentToSave = (type === 'image' || type === 'document') ? (mediaUrl || message) : message;
    await tenantPool.query(
      `INSERT INTO public.chat_messages (session_id, sender_type, message_type, message_content)
       VALUES ($1, 'agent', $2, $3)`,
      [sessionId, type || 'text', contentToSave]
    );

    // Update session status to paused (takeover) and update activity
    await tenantPool.query(
      "UPDATE public.chat_sessions SET session_status = 'paused', last_interaction = CURRENT_TIMESTAMP WHERE id = $1",
      [sessionId]
    );

    res.json({ success: true, message: 'Message sent and bot paused for takeover.' });
  } catch (err) {
    console.error('Error in operator reply:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST: Resume chatbot manually
app.post('/api/sessions/:id/resume', async (req, res) => {
  const { client_id } = req.body;
  const sessionId = req.params.id;
  if (!client_id) return res.status(400).json({ error: 'client_id is required.' });

  try {
    const centralClient = await db.getCentralClient();
    const clientRes = await centralClient.query('SELECT db_name FROM public.clients WHERE id = $1', [client_id]);
    centralClient.release();

    if (clientRes.rows.length === 0) return res.status(404).json({ error: 'Client not found.' });
    const tenantPool = db.getTenantPool(clientRes.rows[0].db_name);

    await tenantPool.query(
      "UPDATE public.chat_sessions SET session_status = 'active', last_interaction = CURRENT_TIMESTAMP WHERE id = $1",
      [sessionId]
    );
    res.json({ success: true, message: 'Chatbot agent resumed.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST: Pause chatbot manually
app.post('/api/sessions/:id/pause', async (req, res) => {
  const { client_id } = req.body;
  const sessionId = req.params.id;
  if (!client_id) return res.status(400).json({ error: 'client_id is required.' });

  try {
    const centralClient = await db.getCentralClient();
    const clientRes = await centralClient.query('SELECT db_name FROM public.clients WHERE id = $1', [client_id]);
    centralClient.release();

    if (clientRes.rows.length === 0) return res.status(404).json({ error: 'Client not found.' });
    const tenantPool = db.getTenantPool(clientRes.rows[0].db_name);

    await tenantPool.query(
      "UPDATE public.chat_sessions SET session_status = 'paused', last_interaction = CURRENT_TIMESTAMP WHERE id = $1",
      [sessionId]
    );
    res.json({ success: true, message: 'Chatbot agent paused.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST: Direct Media Upload without RAG vectorization (specifically for live operators sending files)
app.post('/api/media/upload', async (req, res) => {
  const { client_id, file_name, file_data } = req.body;
  if (!client_id || !file_name || !file_data) {
    return res.status(400).json({ error: 'client_id, file_name, and file_data (base64) are required.' });
  }
  try {
    const uploadDir = path.join(__dirname, 'public', 'media');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    const safeFilename = `${Date.now()}_${file_name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const localFilePath = path.join(uploadDir, safeFilename);
    const buffer = Buffer.from(file_data, 'base64');
    fs.writeFileSync(localFilePath, buffer);

    let publicUrl = `/media/${safeFilename}`;
    if (process.env.APP_URL) {
      publicUrl = `${process.env.APP_URL}/media/${safeFilename}`;
    } else {
      const host = req.get('host');
      const protocol = req.protocol;
      publicUrl = `${protocol}://${host}/media/${safeFilename}`;
    }

    res.json({ success: true, file_url: publicUrl });
  } catch (err) {
    console.error('Operator media upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST: Submit a new template to Meta
app.post('/api/templates', async (req, res) => {
  const { client_id, name, category, language, components } = req.body;
  if (!client_id || !name || !category || !language || !components) {
    return res.status(400).json({ error: 'All fields (client_id, name, category, language, components) are required.' });
  }

  try {
    const centralClient = await db.getCentralClient();
    const clientRes = await centralClient.query(
      'SELECT whatsapp_business_id, system_access_token FROM public.clients WHERE id = $1',
      [client_id]
    );
    centralClient.release();

    if (clientRes.rows.length === 0) return res.status(404).json({ error: 'Client not found.' });
    const { whatsapp_business_id, system_access_token } = clientRes.rows[0];

    const url = `https://graph.facebook.com/v18.0/${whatsapp_business_id}/message_templates`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${system_access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name, category, language, components })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Meta API error' });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE: Delete a template from Meta
app.delete('/api/templates/:name', async (req, res) => {
  const { client_id } = req.query;
  const name = req.params.name;
  if (!client_id) return res.status(400).json({ error: 'client_id is required.' });

  try {
    const centralClient = await db.getCentralClient();
    const clientRes = await centralClient.query(
      'SELECT whatsapp_business_id, system_access_token FROM public.clients WHERE id = $1',
      [client_id]
    );
    centralClient.release();

    if (clientRes.rows.length === 0) return res.status(404).json({ error: 'Client not found.' });
    const { whatsapp_business_id, system_access_token } = clientRes.rows[0];

    const url = `https://graph.facebook.com/v18.0/${whatsapp_business_id}/message_templates?name=${name}`;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${system_access_token}`
      }
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Meta API error' });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET: Fetch CRM contacts with unsubscribed status
app.get('/api/contacts', async (req, res) => {
  const { client_id } = req.query;
  if (!client_id) return res.status(400).json({ error: 'client_id parameter is required.' });

  try {
    const centralClient = await db.getCentralClient();
    const clientRes = await centralClient.query('SELECT db_name FROM public.clients WHERE id = $1', [client_id]);
    centralClient.release();

    if (clientRes.rows.length === 0) return res.status(404).json({ error: 'Client not found.' });
    const tenantPool = db.getTenantPool(clientRes.rows[0].db_name);

    const result = await tenantPool.query(`
      SELECT c.*, (u.customer_phone IS NOT NULL) AS is_unsubscribed
      FROM public.contacts c
      LEFT JOIN public.unsubscribed_contacts u ON u.customer_phone = c.phone
      ORDER BY c.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST: Add or Update single contact
app.post('/api/contacts', async (req, res) => {
  const { client_id, name, phone, tags, notes } = req.body;
  if (!client_id || !phone) return res.status(400).json({ error: 'client_id and phone are required.' });

  try {
    const centralClient = await db.getCentralClient();
    const clientRes = await centralClient.query('SELECT db_name FROM public.clients WHERE id = $1', [client_id]);
    centralClient.release();

    if (clientRes.rows.length === 0) return res.status(404).json({ error: 'Client not found.' });
    const tenantPool = db.getTenantPool(clientRes.rows[0].db_name);

    const formattedTags = Array.isArray(tags) ? tags : (tags ? tags.split(',').map(t => t.trim()) : []);

    const result = await tenantPool.query(`
      INSERT INTO public.contacts (name, phone, tags, notes, updated_at)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      ON CONFLICT (phone) DO UPDATE SET
        name = EXCLUDED.name,
        tags = EXCLUDED.tags,
        notes = EXCLUDED.notes,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [name || '', phone, formattedTags, notes || '']);

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST: Add contacts in bulk (for CSV/Excel imports)
app.post('/api/contacts/bulk', async (req, res) => {
  const { client_id, contacts } = req.body;
  if (!client_id || !Array.isArray(contacts)) {
    return res.status(400).json({ error: 'client_id and an array of contacts are required.' });
  }

  try {
    const centralClient = await db.getCentralClient();
    const clientRes = await centralClient.query('SELECT db_name FROM public.clients WHERE id = $1', [client_id]);
    centralClient.release();

    if (clientRes.rows.length === 0) return res.status(404).json({ error: 'Client not found.' });
    const tenantPool = db.getTenantPool(clientRes.rows[0].db_name);

    let inserted = 0;
    for (const c of contacts) {
      if (!c.phone) continue;
      const formattedTags = Array.isArray(c.tags) ? c.tags : (c.tags ? c.tags.split(',').map(t => t.trim()) : []);
      await tenantPool.query(`
        INSERT INTO public.contacts (name, phone, tags, notes, updated_at)
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        ON CONFLICT (phone) DO UPDATE SET
          name = EXCLUDED.name,
          tags = EXCLUDED.tags,
          notes = EXCLUDED.notes,
          updated_at = CURRENT_TIMESTAMP
      `, [c.name || '', c.phone, formattedTags, c.notes || '']);
      inserted++;
    }

    res.json({ success: true, count: inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE: Delete a CRM contact
app.delete('/api/contacts/:id', async (req, res) => {
  const { client_id } = req.query;
  const id = req.params.id;
  if (!client_id) return res.status(400).json({ error: 'client_id parameter is required.' });

  try {
    const centralClient = await db.getCentralClient();
    const clientRes = await centralClient.query('SELECT db_name FROM public.clients WHERE id = $1', [client_id]);
    centralClient.release();

    if (clientRes.rows.length === 0) return res.status(404).json({ error: 'Client not found.' });
    const tenantPool = db.getTenantPool(clientRes.rows[0].db_name);

    await tenantPool.query('DELETE FROM public.contacts WHERE id = $1', [id]);
    res.json({ success: true, message: 'Contact deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET: Fetch campaign logs (failures breakdown or complete log)
app.get('/api/campaigns/:id/logs', async (req, res) => {
  const { client_id, status } = req.query;
  const campaignId = req.params.id;
  if (!client_id) return res.status(400).json({ error: 'client_id is required.' });

  try {
    const centralClient = await db.getCentralClient();
    const clientRes = await centralClient.query('SELECT db_name FROM public.clients WHERE id = $1', [client_id]);
    centralClient.release();

    if (clientRes.rows.length === 0) return res.status(404).json({ error: 'Client not found.' });
    const tenantPool = db.getTenantPool(clientRes.rows[0].db_name);

    let query = 'SELECT recipient_phone, status, error_message, updated_at FROM public.campaign_logs WHERE campaign_id = $1';
    let params = [campaignId];

    if (status) {
      query += ' AND status = $2';
      params.push(status);
    }
    
    query += ' ORDER BY updated_at DESC';

    const result = await tenantPool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// UNIFIED WHATSAPP WEBHOOK ROUTER
// -------------------------------------------------------------

// Webhook subscription validation (GET)
app.get('/webhook', async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token) {
    try {
      const centralClient = await db.getCentralClient();
      const clientRes = await centralClient.query(
        'SELECT 1 FROM public.clients WHERE webhook_verify_token = $1',
        [token]
      );
      centralClient.release();

      if (clientRes.rows.length > 0) {
        console.log('Webhook verified successfully.');
        return res.status(200).send(challenge);
      } else {
        console.warn('Webhook verification token mismatch.');
        return res.sendStatus(403);
      }
    } catch (err) {
      console.error('Error during verify lookup:', err);
      return res.sendStatus(500);
    }
  }
  return res.sendStatus(400);
});

// Webhook payload ingestion (POST)
app.post('/webhook', async (req, res) => {
  // Acknowledge receipt to Meta immediately (prevents retries)
  res.status(200).send('EVENT_RECEIVED');

  try {
    const entry = req.body.entry;
    if (!entry || !entry[0]?.changes?.[0]?.value) {
      return;
    }

    const value = entry[0].changes[0].value;
    const phoneId = value.metadata?.phone_number_id;

    if (!phoneId) return;

    // 1. Resolve Client metadata from Central DB
    const client = await db.findClientByPhoneId(phoneId);
    if (!client) {
      // Discard event since client is not active/listening
      return;
    }

    const dbName = client.db_name;
    const tenantPool = db.getTenantPool(dbName);

    // 2. Handle Message Status Updates (sent, delivered, read, failed)
    if (value.statuses && value.statuses[0]) {
      const statusObj = value.statuses[0];
      const wamid = statusObj.id;
      const status = statusObj.status; // sent, delivered, read, failed
      const errorMsg = statusObj.errors ? statusObj.errors[0]?.message : null;

      console.log(`Received status update for wamid ${wamid}: ${status}`);

      await tenantPool.query(
        `UPDATE public.campaign_logs 
         SET status = $1, error_message = COALESCE($2, error_message), updated_at = CURRENT_TIMESTAMP 
         WHERE wamid = $3`,
        [status, errorMsg, wamid]
      );
      return;
    }

    // 3. Handle Incoming Messages (text, interactive replies, images)
    if (value.messages && value.messages[0]) {
      const messageObj = value.messages[0];
      const wamid = messageObj.id;
      const recipientPhone = messageObj.from;
      const profileName = value.contacts?.[0]?.profile?.name || 'Customer';

      // A. Webhook Deduplication (Idempotency check in Redis)
      const isDuplicate = await redisClient.set(`wamid:${wamid}`, '1', {
        EX: 300, // Expire after 5 minutes
        NX: true
      });
      if (!isDuplicate) {
        console.log(`Duplicate message discarded. wamid: ${wamid}`);
        return;
      }

      // B. Unsubscribe / Compliance Check
      const unsubCheck = await tenantPool.query(
        'SELECT 1 FROM public.unsubscribed_contacts WHERE customer_phone = $1',
        [recipientPhone]
      );
      if (unsubCheck.rows.length > 0) {
        console.log(`Ignored message from unsubscribed phone: ${recipientPhone}`);
        return;
      }

      // Resolve Agent configuration
      const centralClient = await db.getCentralClient();
      const agentRes = await centralClient.query('SELECT * FROM public.ai_agents WHERE client_id = $1', [client.id]);
      centralClient.release();

      // If no agent prompt exists, bypass bot entirely
      if (agentRes.rows.length === 0) {
        console.warn(`No AI Agent configured for client ${client.name}. Bypassing bot.`);
        return;
      }

      const agent = agentRes.rows[0];

      // Retrieve/Create Chat Session
      let sessionRes = await tenantPool.query(
        'SELECT * FROM public.chat_sessions WHERE customer_phone = $1',
        [recipientPhone]
      );
      
      let session;
      if (sessionRes.rows.length === 0) {
        const createSession = await tenantPool.query(
          `INSERT INTO public.chat_sessions (customer_phone, session_status) 
           VALUES ($1, 'inactive') RETURNING *`,
          [recipientPhone]
        );
        session = createSession.rows[0];
      } else {
        session = sessionRes.rows[0];
      }

      // C. Human Takeover (Pause check)
      if (session.session_status === 'paused') {
        const lastActivity = new Date(session.last_interaction);
        const hoursSinceLast = (new Date() - lastActivity) / (1000 * 60 * 60);
        
        if (hoursSinceLast < 24) {
          console.log(`Chat bot paused for human takeover. Bypassing message from ${recipientPhone}`);
          return;
        } else {
          // Auto-resume bot after 24h of inactivity
          await tenantPool.query(
            "UPDATE public.chat_sessions SET session_status = 'inactive' WHERE id = $1",
            [session.id]
          );
          session.session_status = 'inactive';
        }
      }

      // D. Message Content Parsing (Text vs Image vs Interactive Buttons)
      let userTextContent = '';
      let mediaId = null;
      let hasImage = false;

      if (messageObj.type === 'text') {
        userTextContent = messageObj.text.body;
      } else if (messageObj.type === 'interactive') {
        // Handle Quick Reply buttons or List replies from campaigns
        const interactive = messageObj.interactive;
        if (interactive.type === 'button_reply') {
          userTextContent = interactive.button_reply.title; // Fallback text is button title
          console.log(`Interactive button reply clicked: "${userTextContent}"`);
          
          // Trigger Chatbot Activation
          await tenantPool.query(
            "UPDATE public.chat_sessions SET session_status = 'active', last_interaction = CURRENT_TIMESTAMP WHERE id = $1",
            [session.id]
          );
          session.session_status = 'active';
        } else if (interactive.type === 'list_reply') {
          userTextContent = interactive.list_reply.title;
          
          // Trigger Chatbot Activation
          await tenantPool.query(
            "UPDATE public.chat_sessions SET session_status = 'active', last_interaction = CURRENT_TIMESTAMP WHERE id = $1",
            [session.id]
          );
          session.session_status = 'active';
        }
      } else if (messageObj.type === 'image') {
        mediaId = messageObj.image.id;
        userTextContent = messageObj.image.caption || 'Image upload';
        hasImage = true;
        console.log(`Received image message. Caption: "${userTextContent}". Media ID: ${mediaId}`);
      } else {
        // Unsupported media fallback (audio, files, etc)
        await sendWhatsAppMessage(
          recipientPhone, 
          "I can only read text messages and images at the moment. Please send your question in text. 😊", 
          client.system_access_token, 
          client.phone_number_id
        );
        return;
      }

      // E. Compliance Keyword Detection
      const cleanUpper = userTextContent.toUpperCase().trim();
      if (cleanUpper === 'STOP' || cleanUpper === 'UNSUBSCRIBE') {
        await tenantPool.query(
          'INSERT INTO public.unsubscribed_contacts (customer_phone) VALUES ($1) ON CONFLICT DO NOTHING',
          [recipientPhone]
        );
        await tenantPool.query(
          "UPDATE public.chat_sessions SET session_status = 'inactive' WHERE id = $1",
          [session.id]
        );
        await sendWhatsAppMessage(
          recipientPhone,
          "You have been successfully unsubscribed from this service. You will receive no further messages. Reply START at any time to resume.",
          client.system_access_token,
          client.phone_number_id
        );
        return;
      }
      if (cleanUpper === 'START') {
        await tenantPool.query('DELETE FROM public.unsubscribed_contacts WHERE customer_phone = $1', [recipientPhone]);
        await sendWhatsAppMessage(
          recipientPhone,
          "Welcome back! You have re-subscribed to our messaging channel. How can I help you today?",
          client.system_access_token,
          client.phone_number_id
        );
        return;
      }

      // E2. Human Handover Detection
      const handoverRegex = /\b(human|agent|support|speak to someone|real person)\b/i;
      if (handoverRegex.test(userTextContent)) {
        console.log(`Human handover request detected from ${recipientPhone}: "${userTextContent}"`);
        
        // Pause the session
        await tenantPool.query(
          "UPDATE public.chat_sessions SET session_status = 'paused', last_interaction = CURRENT_TIMESTAMP WHERE id = $1",
          [session.id]
        );

        // Save customer query
        await tenantPool.query(
          `INSERT INTO public.chat_messages (session_id, sender_type, message_type, message_content) 
           VALUES ($1, 'human', 'text', $2)`,
          [session.id, userTextContent]
        );

        // Save and send handover announcement
        const handoverReply = "Connecting you to a human agent, please wait... 🤝 Our team has been notified and will reply shortly. (Bot paused)";
        await tenantPool.query(
          `INSERT INTO public.chat_messages (session_id, sender_type, message_type, message_content) 
           VALUES ($1, 'ai', 'text', $2)`,
          [session.id, handoverReply]
        );

        await sendWhatsAppMessage(
          recipientPhone,
          handoverReply,
          client.system_access_token,
          client.phone_number_id
        );
        return;
      }

      // F. Handle Bot Trigger Action
      // Auto-activate session on ANY incoming text message so the bot always replies.
      if (session.session_status !== 'active') {
        if (messageObj.type === 'text' || messageObj.type === 'image') {
          console.log(`Auto-activating session for ${recipientPhone} on incoming message.`);
          await tenantPool.query(
            "UPDATE public.chat_sessions SET session_status = 'active', last_interaction = CURRENT_TIMESTAMP WHERE id = $1",
            [session.id]
          );
          session.session_status = 'active';
        } else {
          console.log(`Session for ${recipientPhone} is INACTIVE and message type is not activating. Skipping.`);
          return;
        }
      }

      // Log User Query
      await tenantPool.query(
        `INSERT INTO public.chat_messages (session_id, sender_type, message_type, message_content) 
         VALUES ($1, 'human', $2, $3)`,
        [session.id, hasImage ? 'image' : 'text', userTextContent]
      );

      // G. Context-Aware RAG (Vector DB Search)
      console.log(`Querying pgvector KB for query: "${userTextContent}"...`);
      const contextRows = await docs.searchVectorKb(dbName, userTextContent, process.env.OPENAI_API_KEY, 4);
      const kbContext = contextRows.map(row => `- [File: ${row.file_name}] ${row.chunk_content}`).join('\n\n');
      console.log(`Found ${contextRows.length} relevant vector KB chunks.`);

      // H. Multimodal Image pipeline
      let imageUrl = null;
      let openAiMessages = [];

      // System date details
      const now = new Date();
      const todayDateIST = now.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' });
      const todayWeekdayIST = now.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'long' });

      // Compose final system prompt
      const finalSystemPrompt = 
        `Today's date in IST is ${todayDateIST}, and today's weekday is ${todayWeekdayIST}.\n\n` +
        `Official Knowledge Base Context:\n${kbContext}\n\n` +
        `Web Search Tool: If you need real-time facts or current information that is not available in the Knowledge Base context, respond ONLY with "[SEARCH: query]". Replace "query" with a concise search query. The system will automatically execute this search, retrieve the results, and present them to you, after which you will provide your final answer to the user.\n\n` +
        agent.system_prompt;

      // Construct LLM Message Array
      openAiMessages.push({ role: 'system', content: finalSystemPrompt });

      // Append Chat History (Last 10 messages for token efficiency)
      const historyRes = await tenantPool.query(
        'SELECT sender_type, message_content FROM public.chat_messages WHERE session_id = $1 ORDER BY id DESC LIMIT 10',
        [session.id]
      );
      // reverse history so it's chronological
      const history = historyRes.rows.reverse();
      history.forEach(row => {
        // Skip current query which we will append manually
        const role = row.sender_type === 'human' ? 'user' : 'assistant';
        openAiMessages.push({ role, content: row.message_content });
      });

      if (hasImage && mediaId) {
        // Fetch and download Meta image
        try {
          const { buffer, mimeType, extension } = await media.downloadMetaMedia(mediaId, client.system_access_token);
          imageUrl = await media.saveMedia(buffer, `upload.${extension}`, mimeType);
          console.log(`Image saved. URL: ${imageUrl}`);

          // Append vision payload for GPT-4o-mini
          const base64Image = buffer.toString('base64');
          openAiMessages.push({
            role: 'user',
            content: [
              { type: 'text', content: userTextContent },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${base64Image}`
                }
              }
            ]
          });
        } catch (mediaErr) {
          console.error('Failed downloading and preparing vision prompt:', mediaErr);
          await sendWhatsAppMessage(
            recipientPhone,
            "I received your image but was unable to process it. Please try again or send text. ⚠️",
            client.system_access_token,
            client.phone_number_id
          );
          return;
        }
      } else {
        // Standard text user query
        openAiMessages.push({ role: 'user', content: userTextContent });
      }

      // I. Trigger Chat Completion Call (Groq or OpenAI)
      console.log('Invoking LLM for response...');
      let botResponse = await llm.getChatCompletion({
        messages: openAiMessages,
        model: agent.model_name,
        temperature: parseFloat(agent.temperature),
        openAiApiKey: process.env.OPENAI_API_KEY,
        groqApiKey: process.env.GROQ_API_KEY,
        hasImage: hasImage
      });

      console.log(`LLM Response: "${botResponse}"`);

      // Web Search Interception
      if (botResponse.includes('[SEARCH:')) {
        const searchMatch = botResponse.match(/\[SEARCH:\s*([^\]]+)\]/i);
        if (searchMatch) {
          const searchQuery = searchMatch[1].trim();
          console.log(`AI Agent requested web search for: "${searchQuery}"`);
          
          // Perform web search
          const searchResults = await searchWeb(searchQuery);
          console.log(`Web search results retrieved, length: ${searchResults.length}`);
          
          // Append search results system prompt
          openAiMessages.push({
            role: 'system',
            content: `Web Search Results for "${searchQuery}":\n\n${searchResults}\n\nPlease analyze the search results above and provide your final response to the user.`
          });
          
          // Re-invoke LLM
          console.log('Re-invoking LLM with web search results...');
          botResponse = await llm.getChatCompletion({
            messages: openAiMessages,
            model: agent.model_name,
            temperature: parseFloat(agent.temperature),
            openAiApiKey: process.env.OPENAI_API_KEY,
            groqApiKey: process.env.GROQ_API_KEY,
            hasImage: hasImage
          });
          console.log(`Final LLM Response (post-search): "${botResponse}"`);
        }
      }

      // J. Save AI response in chat log history
      await tenantPool.query(
        `INSERT INTO public.chat_messages (session_id, sender_type, message_type, message_content) 
         VALUES ($1, 'ai', 'text', $2)`,
        [session.id, botResponse]
      );
      
      // Update session last interaction time
      await tenantPool.query(
        'UPDATE public.chat_sessions SET last_interaction = CURRENT_TIMESTAMP WHERE id = $1',
        [session.id]
      );

      // K. Dispatch WhatsApp response
      let messagesToSend = [botResponse];
      if (botResponse.includes('[SEND]')) {
        messagesToSend = botResponse
          .split('[SEND]')
          .map(msg => msg.trim())
          .filter(msg => msg.length > 0);
      }

      for (const msg of messagesToSend) {
        await sendWhatsAppMessage(recipientPhone, msg, client.system_access_token, client.phone_number_id);
        await new Promise(r => setTimeout(r, 1000));
      }

      // L. Booking Confirmation Logic (original calendar automation)
      if (botResponse.toLowerCase().includes('[booking_confirmed]')) {
        console.log('Booking confirmation marker detected! Scheduling...');
        try {
          const nameMatch = botResponse.match(/Name:\s*([^,\n]+)/i);
          const customerName = nameMatch ? nameMatch[1].trim() : profileName;

          const emailMatch = botResponse.match(/Email:\s*([^\s,\n]+@[^\s,\n]+)/i);
          const email = emailMatch ? emailMatch[1].trim() : '';

          const businessMatch = botResponse.match(/(?:Business Name|Business):\s*([^,\n]+)/i);
          const businessName = businessMatch ? businessMatch[1].trim() : 'Unknown';

          const staffMatch = botResponse.match(/(?:Staff Count|Staff):\s*(\d+)/i);
          const staffCount = staffMatch ? staffMatch[1].trim() : 'Unknown';

          const dateTimeMatch = botResponse.match(/on\s+(?:\w+,\s+)?(\d{1,2}\s+\w+\s+\d{4})\s+at\s+(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
          
          let startISO = '';
          let endISO = '';

          if (dateTimeMatch) {
            const combined = dateTimeMatch[1] + ' ' + dateTimeMatch[2];
            const parsedDate = new Date(combined + ' +0530'); // IST
            if (!isNaN(parsedDate.getTime())) {
              startISO = parsedDate.toISOString();
              endISO = new Date(parsedDate.getTime() + 30 * 60 * 1000).toISOString();
            }
          }

          if (startISO && endISO) {
            const authClient = getGoogleAuthClient();
            const calendar = google.calendar({ version: 'v3', auth: authClient });

            const calendarResponse = await calendar.events.insert({
              calendarId: 'primary',
              resource: {
                summary: `PagarBook Live Demo - ${customerName} (${businessName})`,
                description: `Customer Name: ${customerName}\nBusiness Name: ${businessName}\nStaff Count: ${staffCount}\nMobile: ${recipientPhone}\nEmail: ${email}\nBooked via WhatsApp AI Bot`,
                start: { dateTime: startISO, timeZone: 'Asia/Kolkata' },
                end: { dateTime: endISO, timeZone: 'Asia/Kolkata' },
                attendees: email ? [{ email: email }] : [],
              },
              sendUpdates: 'all'
            });

            const htmlLink = calendarResponse.data.htmlLink;
            console.log(`Calendar event created: ${htmlLink}`);

            // Send confirmation details back via WhatsApp
            const whatsappConfirmMessage = `Your demo slot has been blocked on our calendar!\n\nView your booking here:\n${htmlLink}\n\nSee you in the live demo!`;
            await sendWhatsAppMessage(recipientPhone, whatsappConfirmMessage, client.system_access_token, client.phone_number_id);
          }
        } catch (bookingErr) {
          console.error('Failed to schedule event:', bookingErr.message);
        }
      }
    }
  } catch (err) {
    console.error('Global Webhook processing error:', err);
  }
});

// -------------------------------------------------------------
// APP INITIALIZATION
// -------------------------------------------------------------

async function bootstrap() {
  try {
    // 1. Initialize Central Database Tables
    await db.initCentralDb();

    // Run tenant migrations for all existing client databases on startup
    console.log('Running automatic database migrations for all onboarded clients...');
    const centralClient = await db.getCentralClient();
    try {
      const clientsRes = await centralClient.query('SELECT db_name FROM public.clients');
      for (const row of clientsRes.rows) {
        try {
          await db.runTenantMigrations(row.db_name);
        } catch (migErr) {
          console.error(`Migration failed for client database: ${row.db_name}`, migErr);
        }
      }
    } catch (migLookupErr) {
      console.error('Failed to lookup clients for database migrations:', migLookupErr);
    } finally {
      centralClient.release();
    }

    // 2. Initialize Redis Connection
    console.log('Connecting to Redis for Webhook deduplication...');
    await redisClient.connect();
    console.log('Connected to Redis.');

    // 3. Initialize BullMQ Campaign Queue Worker
    queue.initQueueWorker();

    // 4. Start Server
    app.listen(PORT, () => {
      console.log(`Multi-tenant WhatsApp platform listening on port ${PORT}`);
    });
  } catch (err) {
    console.error('Fatal initialization error:', err);
    process.exit(1);
  }
}

bootstrap();
