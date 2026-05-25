// Set environment configs temporarily to run locally or from VPS
process.env.PGHOST = process.env.PGHOST || 'w04cscwsccsc880sc488cscg'; // Coolify internal pg
process.env.PGPORT = process.env.PGPORT || '5432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'AGENTiX@2025';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';

const db = require('./db');
const fs = require('fs');
const path = require('path');

async function main() {
  const secretsPath = path.join(__dirname, 'Secrets.txt');
  if (!fs.existsSync(secretsPath)) {
    console.error('Error: Secrets.txt not found in workspace.');
    process.exit(1);
  }

  console.log('Reading Secrets.txt...');
  const content = fs.readFileSync(secretsPath, 'utf8');

  // Extract variables using regular expressions
  const appIdMatch = content.match(/App ID:?\s*(\d+)/i);
  const appSecretMatch = content.match(/App secret:?\s*([a-f0-9]+)/i);
  const phoneIdMatch = content.match(/Phone number ID:?\s*(\d+)/i);
  const businessIdMatch = content.match(/WhatsApp Business Account ID:?\s*(\d+)/i);
  const tokenMatch = content.match(/permanent access token:?\s*([^\s\r\n]+)/i);

  if (!appIdMatch || !appSecretMatch || !phoneIdMatch || !businessIdMatch || !tokenMatch) {
    console.error('Error: Could not parse all credentials from Secrets.txt.');
    console.log('Parsed findings:', {
      appId: appIdMatch ? appIdMatch[1] : 'missing',
      appSecret: appSecretMatch ? 'found' : 'missing',
      phoneId: phoneIdMatch ? phoneIdMatch[1] : 'missing',
      businessId: businessIdMatch ? businessIdMatch[1] : 'missing',
      token: tokenMatch ? 'found' : 'missing',
    });
    process.exit(1);
  }

  const clientName = 'Pagarbook VMS';
  const appId = appIdMatch[1];
  const appSecret = appSecretMatch[1];
  const phoneId = phoneIdMatch[1];
  const businessId = businessIdMatch[1];
  const token = tokenMatch[1];
  const verifyToken = 'pagarbook_whatsapp_verify_token_2026';

  console.log(`Parsed credentials successfully. Onboarding client: "${clientName}"...`);
  console.log({
    name: clientName,
    appId,
    phoneId,
    businessId,
    verifyToken
  });

  try {
    // 1. Initialize central table if not exists
    await db.initCentralDb();

    // 2. Programmatically create client database and run migrations
    const dbName = await db.createTenantDatabase(
      clientName,
      phoneId,
      businessId,
      appId,
      appSecret,
      token,
      verifyToken
    );

    console.log('\n======================================================');
    console.log(' SUCCESS: FIRST CLIENT ONBOARDED SUCCESSFULLY!');
    console.log('======================================================');
    console.log(`- Database Created:  ${dbName}`);
    console.log(`- Meta Verify Token: ${verifyToken}`);
    console.log(`- Webhook URL:       https://pagarbook-bot.76.13.250.173.sslip.io/webhook`);
    console.log('======================================================\n');

  } catch (err) {
    console.error('Fatal onboarding error:', err.message);
    console.log('\nMake sure this script is run from a shell that can reach your Postgres database server.');
  } finally {
    // End the pool connection
    const pool = db.getCentralClient().then(c => {
      c.release();
    }).catch(() => {});
  }
}

main();
