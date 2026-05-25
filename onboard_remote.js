const fs = require('fs');
const path = require('path');

const targetUrl = 'https://pagarbook.aiagentixdev.com';

async function main() {
  const secretsPath = path.join(__dirname, 'Secrets.txt');
  if (!fs.existsSync(secretsPath)) {
    console.error('Error: Secrets.txt not found in workspace.');
    process.exit(1);
  }

  const content = fs.readFileSync(secretsPath, 'utf8');

  // Extract variables
  const appIdMatch = content.match(/App ID:?\s*(\d+)/i);
  const appSecretMatch = content.match(/App secret:?\s*([a-f0-9]+)/i);
  const phoneIdMatch = content.match(/Phone number ID:?\s*(\d+)/i);
  const businessIdMatch = content.match(/WhatsApp Business Account ID:?\s*(\d+)/i);
  const tokenMatch = content.match(/permanent access token:?\s*([^\s\r\n]+)/i);

  if (!appIdMatch || !appSecretMatch || !phoneIdMatch || !businessIdMatch || !tokenMatch) {
    console.error('Error parsing credentials.');
    process.exit(1);
  }

  const payload = {
    name: 'Pagarbook VMS',
    phone_number_id: phoneIdMatch[1],
    whatsapp_business_id: businessIdMatch[1],
    app_id: appIdMatch[1],
    app_secret: appSecretMatch[1],
    system_access_token: tokenMatch[1],
    webhook_verify_token: 'pagarbook_whatsapp_verify_token_2026'
  };

  console.log(`Sending onboarding request to remote VPS: ${targetUrl}...`);
  console.log({
    name: payload.name,
    phone_number_id: payload.phone_number_id,
    whatsapp_business_id: payload.whatsapp_business_id,
    app_id: payload.app_id,
    webhook_verify_token: payload.webhook_verify_token
  });

  try {
    const res = await fetch(`${targetUrl}/api/clients`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const result = await res.json();
    if (res.ok) {
      console.log('\n======================================================');
      console.log(' SUCCESS: CLIENT ONBOARDED REMOTELY ON YOUR VPS!');
      console.log('======================================================');
      console.log(`- Database Name: ${result.db_name}`);
      console.log(`- API Message:   ${result.message}`);
      console.log('======================================================\n');
    } else {
      console.error(`Onboarding failed: ${res.status} - ${result.error}`);
    }
  } catch (err) {
    console.error('Connection failed (server might still be building/redeploying in Coolify):', err.message);
  }
}

main();
