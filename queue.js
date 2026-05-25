const { Queue, Worker } = require('bullmq');
const { getTenantPool } = require('./db');

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// Configure Redis Connection Options
const redisConnection = {
  url: redisUrl,
  // For BullMQ v5, when passing url inside connection object:
  // If we run into issues, BullMQ connection parses standard redis connection params.
};

// Create the Queue instance
const campaignQueue = new Queue('whatsappCampaigns', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000, // Starts at 5s, then 10s, 20s
    },
    removeOnComplete: true,
    removeOnFail: false,
  }
});

// Create Queue Scheduler or Worker
let worker;

function initQueueWorker() {
  if (worker) return;

  console.log('Initializing campaign queue worker...');
  
  worker = new Worker('whatsappCampaigns', async (job) => {
    const { 
      recipientPhone, 
      templateName, 
      languageCode, 
      components, // template parameters
      accessToken, 
      phoneNumberId, 
      dbName, 
      campaignLogId 
    } = job.data;

    const tenantPool = getTenantPool(dbName);

    // 1. Double check unsubscribe list before sending
    try {
      const unsubCheck = await tenantPool.query(
        'SELECT 1 FROM public.unsubscribed_contacts WHERE customer_phone = $1',
        [recipientPhone]
      );
      if (unsubCheck.rows.length > 0) {
        console.log(`Skipping unsubscribed recipient: ${recipientPhone} in ${dbName}`);
        await tenantPool.query(
          'UPDATE public.campaign_logs SET status = $1, error_message = $2 WHERE id = $3',
          ['failed', 'Unsubscribed Contact', campaignLogId]
        );
        return; // Complete job successfully (skipped)
      }
    } catch (dbErr) {
      console.error('Error checking unsubscribe status in worker:', dbErr);
      throw dbErr; // Retry job
    }

    // 2. Dispatch to Meta Cloud API
    const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
    
    // Structure template payload
    const payload = {
      messaging_product: 'whatsapp',
      to: recipientPhone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode || 'en' }
      }
    };
    if (components) {
      payload.template.components = components;
    }

    try {
      console.log(`Sending campaign template ${templateName} to ${recipientPhone}...`);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const result = await response.json();

      if (!response.ok) {
        const errorMsg = result.error ? result.error.message : 'Unknown Meta API error';
        const errorCode = result.error ? result.error.code : 0;
        
        console.error(`Meta API failed for ${recipientPhone}: code ${errorCode} - ${errorMsg}`);
        
        // If it's a rate-limiting or transient error, throw error to trigger BullMQ backoff retry
        if (errorCode === 130429 || errorCode === 4 || errorCode === 130430 || response.status === 429) {
          throw new Error(`Meta API rate limit/transient error: ${errorMsg}`);
        }

        // For permanent errors, mark campaign log as failed and complete the job
        await tenantPool.query(
          'UPDATE public.campaign_logs SET status = $1, error_message = $2 WHERE id = $3',
          ['failed', errorMsg, campaignLogId]
        );
        return;
      }

      // Successful dispatch
      const wamid = result.messages?.[0]?.id;
      console.log(`Campaign message dispatched. wamid: ${wamid}`);
      
      await tenantPool.query(
        'UPDATE public.campaign_logs SET status = $1, wamid = $2 WHERE id = $3',
        ['sent', wamid, campaignLogId]
      );

    } catch (err) {
      console.error(`Error in worker processing job for ${recipientPhone}:`, err.message);
      // Re-throw to trigger BullMQ retry logic
      throw err;
    }
  }, {
    connection: redisConnection,
    concurrency: 50, // Process up to 50 concurrent dispatches to meet high throughput
    limiter: {
      max: 80, // Safe Meta API limit (80 messages per second)
      duration: 1000,
    }
  });

  worker.on('failed', (job, err) => {
    console.error(`Campaign Job ${job.id} permanently failed: ${err.message}`);
  });
}

// Add campaign jobs in bulk
async function enqueueCampaign(client, campaignId, templateName, languageCode, recipients, components) {
  const dbName = client.db_name;
  const tenantPool = getTenantPool(dbName);
  
  console.log(`Queueing ${recipients.length} campaign jobs for client ${client.name}...`);
  
  const jobs = [];

  for (const phone of recipients) {
    // 1. Create a log row as queued
    const logRes = await tenantPool.query(
      `INSERT INTO public.campaign_logs (campaign_id, recipient_phone, status) 
       VALUES ($1, $2, 'queued') RETURNING id`,
      [campaignId, phone]
    );
    const campaignLogId = logRes.rows[0].id;

    // 2. Build Job payload
    jobs.push({
      name: `campaign-msg-${phone}`,
      data: {
        recipientPhone: phone,
        templateName,
        languageCode,
        components,
        accessToken: client.system_access_token,
        phoneNumberId: client.phone_number_id,
        dbName,
        campaignLogId,
      }
    });
  }

  // BullMQ support bulk adds for high performance
  await campaignQueue.addBulk(jobs);
  
  // Update campaign status
  await tenantPool.query(
    'UPDATE public.campaigns SET status = $1, total_recipients = $2 WHERE id = $3',
    ['processing', recipients.length, campaignId]
  );
  
  console.log(`Successfully enqueued all campaign messages.`);
}

module.exports = {
  initQueueWorker,
  enqueueCampaign,
  campaignQueue,
};
