const assert = require('assert');

// -------------------------------------------------------------
// 1. DYNAMIC MOCK MODULE HOOKS (PG, REDIS, BULLMQ, FETCH)
// -------------------------------------------------------------

// Mock PostgreSQL
const mockPgClient = {
  connect: async () => {},
  query: async (sql, params) => {
    if (sql.includes('pg_database')) {
      return { rows: [] };
    }
    return { rows: [] };
  },
  end: async () => {}
};

const mockPoolClient = {
  query: async (sql, params) => {
    // Return client configurations in central database
    if (sql.includes('public.clients')) {
      if (sql.includes('INSERT') || sql.includes('UPDATE')) {
        return { rows: [] };
      }
      // Return empty if verify token doesn't match
      if (sql.includes('webhook_verify_token = $1') && params && params[0] !== 'pagarbook_whatsapp_verify_token_2026') {
        return { rows: [] };
      }
      return {
        rows: [{
          id: 'client-uuid-123',
          name: 'Umang Hospital',
          db_name: 'client_umang_hospital_db',
          phone_number_id: '1201782259675601',
          whatsapp_business_id: '1642047753726751',
          app_id: '1009514481606880',
          app_secret: 'c4176c068ebbae66ee34cd85f2888786',
          system_access_token: 'EAAOW...',
          webhook_verify_token: 'pagarbook_whatsapp_verify_token_2026',
          is_listening: true
        }]
      };
    }
    
    // Return agent configurations
    if (sql.includes('public.ai_agents')) {
      return {
        rows: [{
          client_id: 'client-uuid-123',
          name: 'Sakshi',
          system_prompt: 'You are Sakshi...',
          temperature: 0.3,
          model_name: 'gpt-4o-mini'
        }]
      };
    }

    // Return active sessions
    if (sql.includes('public.chat_sessions')) {
      if (sql.includes('INSERT') || sql.includes('UPDATE')) {
        return { rows: [{ id: 'session-123', customer_phone: '918588072727', session_status: 'active' }] };
      }
      return {
        rows: [{
          id: 'session-123',
          customer_phone: '918588072727',
          session_status: 'active',
          last_interaction: new Date().toISOString()
        }]
      };
    }

    // Return campaigns
    if (sql.includes('public.campaigns')) {
      return { rows: [{ id: 'campaign-uuid-123' }] };
    }

    // Return campaign logs
    if (sql.includes('public.campaign_logs')) {
      return { rows: [{ id: 'campaign-log-uuid-456' }] };
    }

    // Return mock documents
    if (sql.includes('public.kb_documents')) {
      return {
        rows: [
          { chunk_content: 'OPD Timing: Mon-Sat 9AM to 1PM.', file_name: 'timings.pdf', similarity: 0.96 }
        ]
      };
    }

    return { rows: [] };
  },
  release: () => {}
};

const mockPgPool = {
  connect: async () => mockPoolClient,
  query: async (sql, params) => {
    return mockPoolClient.query(sql, params);
  },
  on: () => {}
};

require('module').prototype.require = new Proxy(require('module').prototype.require, {
  apply(target, thisArg, argumentsList) {
    const name = argumentsList[0];
    if (name === 'pg') {
      return {
        Pool: function() { return mockPgPool; },
        Client: function() { return mockPgClient; }
      };
    }
    if (name === 'redis') {
      return {
        createClient: function() {
          return {
            on: () => {},
            connect: async () => {},
            set: async (key, val, opts) => {
              if (mockRedisCache[key]) return null;
              mockRedisCache[key] = val;
              return 'OK';
            },
            get: async (key) => mockRedisCache[key] || null,
            cache: mockRedisCache
          };
        }
      };
    }
    if (name === 'bullmq') {
      return {
        Queue: function() {
          return {
            addBulk: async (jobs) => {
              mockCampaignJobs.push(...jobs);
            }
          };
        },
        Worker: function() {
          return {
            on: () => {}
          };
        }
      };
    }
    return Reflect.apply(target, thisArg, argumentsList);
  }
});

const mockRedisCache = {};
const mockCampaignJobs = [];
const mockOutgoingMessages = [];

// Intercept Global Fetch to prevent external network queries
const originalFetch = global.fetch;
global.fetch = async (url, options) => {
  const method = options?.method || 'GET';
  const body = options?.body ? JSON.parse(options.body) : null;
  const headers = options?.headers || {};

  // OpenAI Embeddings Mock
  if (url.includes('api.openai.com/v1/embeddings')) {
    return {
      ok: true,
      json: async () => ({
        data: [{ embedding: Array(1536).fill(0.01) }]
      })
    };
  }

  // OpenAI Chat Completions Mock
  if (url.includes('api.openai.com/v1/chat/completions')) {
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Mocked AI Agent Reply [booking_confirmed] Name: John, Email: john@example.com, Business: ABC, Staff: 12 on 26 May 2026 at 10:00 AM' } }]
      })
    };
  }

  // Meta Cloud API Message Mock
  if (url.includes('graph.facebook.com') && url.includes('/messages')) {
    mockOutgoingMessages.push({ url, body });
    return {
      ok: true,
      json: async () => ({
        messages: [{ id: 'mock-wamid-response-456' }]
      })
    };
  }

  // Google Calendar Mock
  if (url.includes('googleapis.com/calendar')) {
    return {
      ok: true,
      json: async () => ({
        htmlLink: 'https://calendar.google.com/event?id=mock-event-123'
      })
    };
  }

  return {
    ok: true,
    text: async () => 'OK',
    json: async () => ({})
  };
};

// -------------------------------------------------------------
// 2. BOOTSTRAP TEST SERVER
// -------------------------------------------------------------

console.log('Mocking dependencies and starting Express Server on port 3001...');
process.env.PORT = '3001';
process.env.PGHOST = '127.0.0.1';
process.env.OPENAI_API_KEY = 'mock-openai-key';
process.env.GROQ_API_KEY = 'mock-groq-key';

// Start Server
require('../server.js');

// Give the server 1 second to bootstrap
setTimeout(runTests, 1000);

// -------------------------------------------------------------
// 3. INTEGRATION TESTS
// -------------------------------------------------------------
async function runTests() {
  console.log('\nStarting integration tests...');
  try {
    // Test 1: GET /webhook subscription verification (Valid verification token)
    console.log('\n[Test 1] Testing Webhook verification with valid token...');
    const verifyRes = await originalFetch('http://localhost:3001/webhook?hub.mode=subscribe&hub.challenge=test_challenge_123&hub.verify_token=pagarbook_whatsapp_verify_token_2026');
    assert.strictEqual(verifyRes.status, 200, 'Verify token should be accepted.');
    const challengeText = await verifyRes.text();
    assert.strictEqual(challengeText, 'test_challenge_123', 'Verify challenge must match.');
    console.log('✅ Test 1 Passed!');

    // Test 2: GET /webhook subscription verification (Invalid verify token)
    console.log('\n[Test 2] Testing Webhook verification with invalid token...');
    const verifyFailRes = await originalFetch('http://localhost:3001/webhook?hub.mode=subscribe&hub.challenge=test_challenge_123&hub.verify_token=wrong_token');
    assert.strictEqual(verifyFailRes.status, 403, 'Verify token mismatch should return 403 Forbidden.');
    console.log('✅ Test 2 Passed!');

    // Test 3: POST /webhook Incoming Customer Message Routing
    console.log('\n[Test 3] Testing incoming user message processing and AI responder...');
    const messagePayload = {
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: '1201782259675601' },
            contacts: [{ profile: { name: 'Vital' } }],
            messages: [{
              id: 'wamid.HBgLOTE4NTg4MDcyNzI3FQIAERgSRDMzNDQ2Q0QwOTc0NUYzRDMA',
              from: '918588072727',
              type: 'text',
              text: { body: 'When is my OPD appointment available?' }
            }]
          },
          field: 'messages'
        }]
      }]
    };

    const webhookPostRes = await originalFetch('http://localhost:3001/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messagePayload)
    });
    
    assert.strictEqual(webhookPostRes.status, 200, 'POST /webhook must immediately return 200.');
    const postText = await webhookPostRes.text();
    assert.strictEqual(postText, 'EVENT_RECEIVED');
    
    // Give 1 second for RAG, completion pipeline, and mock dispatches to run async
    await new Promise(r => setTimeout(r, 1000));

    // Verify mock WhatsApp API was hit
    assert.ok(mockOutgoingMessages.length > 0, 'Should dispatch a response back to customer.');
    console.log(`Outgoing messages logged: ${mockOutgoingMessages.length}`);
    mockOutgoingMessages.forEach((m, idx) => {
      console.log(`- Msg #${idx + 1} to ${m.body.to}: "${m.body.text.body}"`);
    });
    console.log('✅ Test 3 Passed!');

    // Test 4: Webhook Event Deduplication
    console.log('\n[Test 4] Testing Webhook message deduplication...');
    // Reset outgoing messages count
    mockOutgoingMessages.length = 0;
    
    // Send duplicate wamid
    const duplicateRes = await originalFetch('http://localhost:3001/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messagePayload)
    });
    
    assert.strictEqual(duplicateRes.status, 200);
    await new Promise(r => setTimeout(r, 500));
    assert.strictEqual(mockOutgoingMessages.length, 0, 'Deduplication should discard the duplicate wamid event.');
    console.log('✅ Test 4 Passed!');

    // Test 5: Onboarding Admin API
    console.log('\n[Test 5] Testing Onboarding API /api/clients...');
    const onboardPayload = {
      name: 'Umang Hospital',
      phone_number_id: '1201782259675601',
      whatsapp_business_id: '1642047753726751',
      app_id: '1009514481606880',
      app_secret: 'c4176c068ebbae66ee34cd85f2888786',
      system_access_token: 'EAAOW...',
      webhook_verify_token: 'pagarbook_whatsapp_verify_token_2026'
    };

    const onboardRes = await originalFetch('http://localhost:3001/api/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(onboardPayload)
    });
    assert.strictEqual(onboardRes.status, 200, 'Should onboard successfully with mock DB provisioner.');
    console.log('✅ Test 5 Passed!');

    // Test 6: Bulk Campaign API Launch
    console.log('\n[Test 6] Testing Campaign Enqueueing /api/campaigns...');
    const campaignPayload = {
      client_id: 'client-uuid-123',
      name: 'OPD Campaign Drive',
      template_name: 'opd_drive_template',
      language_code: 'en',
      recipients: ['+918588072727', '+918882801378']
    };

    const campaignRes = await originalFetch('http://localhost:3001/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(campaignPayload)
    });
    assert.strictEqual(campaignRes.status, 200, 'Enqueuing bulk campaign should return 200.');
    
    // Verify jobs were loaded to mock queue
    assert.strictEqual(mockCampaignJobs.length, 2, 'Should add 2 jobs to BullMQ.');
    console.log(`Enqueued BullMQ campaign jobs logged: ${mockCampaignJobs.length}`);
    mockCampaignJobs.forEach((j, idx) => {
      console.log(`- Job #${idx + 1}: Send template "${j.data.templateName}" to ${j.data.recipientPhone}`);
    });
    console.log('✅ Test 6 Passed!');

    console.log('\n======================================================');
    console.log(' ALL 6 MOCK INTEGRATION TESTS PASSED SUCCESSFULLY! 🎉');
    console.log('======================================================\n');
    process.exit(0);

  } catch (err) {
    console.error('❌ Integration test failed:', err);
    process.exit(1);
  }
}
