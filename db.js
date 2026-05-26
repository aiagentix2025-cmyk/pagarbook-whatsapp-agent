const { Pool, Client } = require('pg');

const centralDbConfig = {
  host: process.env.PGHOST || '127.0.0.1',
  port: parseInt(process.env.PGPORT || '5432'),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'AGENTiX@2025',
  database: process.env.PGDATABASE || 'postgres',
};

// Central connection pool
const centralPool = new Pool(centralDbConfig);

// Cache for tenant connection pools (dbname -> Pool)
const tenantPools = {};

// Helper: Get connection client for central DB
async function getCentralClient() {
  return await centralPool.connect();
}

// Initialize central configuration tables
async function initCentralDb() {
  const client = await getCentralClient();
  try {
    console.log('Initializing central admin tables...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.clients (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        db_name VARCHAR(100) UNIQUE NOT NULL,
        phone_number_id VARCHAR(255) UNIQUE NOT NULL,
        whatsapp_business_id VARCHAR(255) NOT NULL,
        app_id VARCHAR(255) NOT NULL,
        app_secret VARCHAR(255) NOT NULL,
        system_access_token TEXT NOT NULL,
        webhook_verify_token VARCHAR(255) NOT NULL,
        is_listening BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS public.ai_agents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID UNIQUE NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        system_prompt TEXT NOT NULL,
        temperature NUMERIC(3,2) DEFAULT 0.3,
        model_name VARCHAR(100) DEFAULT 'gpt-4o-mini',
        vision_enabled BOOLEAN DEFAULT FALSE,
        opt_out_message TEXT,
        opt_in_message TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Add vision_enabled column to public.ai_agents if it doesn't exist
    await client.query(`
      ALTER TABLE public.ai_agents ADD COLUMN IF NOT EXISTS vision_enabled BOOLEAN DEFAULT FALSE;
    `);

    // Add opt_out_message column if it doesn't exist
    await client.query(`
      ALTER TABLE public.ai_agents ADD COLUMN IF NOT EXISTS opt_out_message TEXT;
    `);

    // Add opt_in_message column if it doesn't exist
    await client.query(`
      ALTER TABLE public.ai_agents ADD COLUMN IF NOT EXISTS opt_in_message TEXT;
    `);

    console.log('Central tables initialized successfully.');
  } catch (err) {
    console.error('Error initializing central DB:', err);
    throw err;
  } finally {
    client.release();
  }
}

// Get or create tenant database connection pool
function getTenantPool(dbName) {
  if (tenantPools[dbName]) {
    return tenantPools[dbName];
  }

  const tenantConfig = {
    ...centralDbConfig,
    database: dbName,
    max: 10, // Limit connections per tenant pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  };

  const pool = new Pool(tenantConfig);
  tenantPools[dbName] = pool;
  return pool;
}

// Run tenant-specific schema migrations
async function runTenantMigrations(dbName) {
  const tenantPool = getTenantPool(dbName);
  const client = await tenantPool.connect();
  try {
    console.log(`Running schema migrations for tenant database: ${dbName}...`);
    
    // 1. Enable Vector Extension (needs to be run in public or extensions schema)
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector SCHEMA public;`);

    // 2. Create Unsubscribed Contacts table
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.unsubscribed_contacts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_phone VARCHAR(50) UNIQUE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 3. Create Campaigns table
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.campaigns (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        template_name VARCHAR(255) NOT NULL,
        language_code VARCHAR(50) DEFAULT 'en',
        total_recipients INTEGER NOT NULL DEFAULT 0,
        status VARCHAR(50) DEFAULT 'draft',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 4. Create Campaign Logs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.campaign_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
        recipient_phone VARCHAR(50) NOT NULL,
        wamid VARCHAR(255) UNIQUE,
        status VARCHAR(50) DEFAULT 'queued',
        error_message TEXT,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_campaign_logs_wamid ON public.campaign_logs(wamid);`);

    // 5. Create Documents Vector table
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.kb_documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        file_name VARCHAR(255) NOT NULL,
        file_url TEXT NOT NULL,
        chunk_content TEXT NOT NULL,
        embedding public.vector(1536) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // Use try-catch for index since it uses custom pgvector syntax that can fail if index already exists
    try {
      await client.query(`
        CREATE INDEX IF NOT EXISTS kb_documents_embedding_idx ON public.kb_documents 
        USING hnsw (embedding public.vector_cosine_ops);
      `);
    } catch (idxErr) {
      console.warn(`Warning creating HNSW index (pgvector HNSW support might require compilation or is already created):`, idxErr.message);
    }

    // 6. Create Chatbot Sessions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.chat_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_phone VARCHAR(50) UNIQUE NOT NULL,
        session_status VARCHAR(50) DEFAULT 'inactive',
        last_interaction TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 7. Create Chat History table
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.chat_messages (
        id BIGSERIAL PRIMARY KEY,
        session_id UUID NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
        sender_type VARCHAR(20) NOT NULL,
        message_type VARCHAR(20) DEFAULT 'text',
        message_content TEXT NOT NULL,
        media_url TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Add media_url column to chat_messages if it doesn't exist
    await client.query(`
      ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS media_url TEXT;
    `);

    // 8. Create Contacts (CRM Address Book) table
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.contacts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255),
        phone VARCHAR(50) UNIQUE NOT NULL,
        tags TEXT[] DEFAULT '{}',
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_contacts_phone ON public.contacts(phone);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_contacts_tags ON public.contacts USING GIN(tags);`);

    console.log(`Tenant migrations for ${dbName} completed successfully.`);
  } catch (err) {
    console.error(`Error running migrations on ${dbName}:`, err);
    throw err;
  } finally {
    client.release();
  }
}

// Provision a new tenant database programmatically
async function createTenantDatabase(clientName, phoneId, businessId, appId, appSecret, token, verifyToken) {
  // Database name must be safe for pg
  const safeDbName = `client_${clientName.toLowerCase().replace(/[^a-z0-9]/g, '_')}_db`;

  // Use a separate client connected to the master DB to run CREATE DATABASE (which cannot run in transaction blocks or standard pool handles easily)
  const client = new Client(centralDbConfig);
  await client.connect();

  try {
    console.log(`Creating database ${safeDbName} for client: ${clientName}...`);
    
    // Check if database exists
    const checkDb = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [safeDbName]);
    if (checkDb.rows.length === 0) {
      // Run CREATE DATABASE without transaction
      await client.query(`CREATE DATABASE ${safeDbName};`);
      console.log(`Database ${safeDbName} created.`);
    } else {
      console.log(`Database ${safeDbName} already exists.`);
    }
  } catch (err) {
    console.error(`Failed to create database ${safeDbName}:`, err);
    throw err;
  } finally {
    await client.end();
  }

  // Run the schema DDL in the new database
  await runTenantMigrations(safeDbName);

  // Register the client in the central clients table
  const centralClient = await getCentralClient();
  try {
    await centralClient.query(`
      INSERT INTO public.clients (name, db_name, phone_number_id, whatsapp_business_id, app_id, app_secret, system_access_token, webhook_verify_token)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (phone_number_id) DO UPDATE SET
        name = EXCLUDED.name,
        db_name = EXCLUDED.db_name,
        whatsapp_business_id = EXCLUDED.whatsapp_business_id,
        app_id = EXCLUDED.app_id,
        app_secret = EXCLUDED.app_secret,
        system_access_token = EXCLUDED.system_access_token,
        webhook_verify_token = EXCLUDED.webhook_verify_token
    `, [clientName, safeDbName, phoneId, businessId, appId, appSecret, token, verifyToken]);
    console.log(`Client metadata registered in central DB for ${clientName}`);
  } finally {
    centralClient.release();
  }

  return safeDbName;
}

// Find client configuration by Meta Phone Number ID
async function findClientByPhoneId(phoneId) {
  const client = await getCentralClient();
  try {
    const res = await client.query(
      'SELECT * FROM public.clients WHERE phone_number_id = $1 AND is_listening = TRUE',
      [phoneId]
    );
    return res.rows[0] || null;
  } finally {
    client.release();
  }
}

module.exports = {
  initCentralDb,
  getCentralClient,
  getTenantPool,
  createTenantDatabase,
  findClientByPhoneId,
  centralDbConfig,
  runTenantMigrations,
};
