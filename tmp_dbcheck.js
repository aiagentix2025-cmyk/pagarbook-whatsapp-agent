const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  // First check what columns exist
  const cols = await p.query("SELECT column_name FROM information_schema.columns WHERE table_name='clients' ORDER BY ordinal_position");
  console.log('\n=== CLIENTS TABLE COLUMNS ===');
  console.log(cols.rows.map(r => r.column_name).join(', '));

  // Check clients with all columns
  const clients = await p.query('SELECT * FROM clients');
  console.log('\n=== CLIENTS DATA ===');
  console.table(clients.rows);

  // Check sessions
  try {
    const sessions = await p.query("SELECT * FROM conversation_sessions ORDER BY updated_at DESC LIMIT 10");
    console.log('\n=== RECENT SESSIONS ===');
    console.table(sessions.rows);
  } catch(e) { console.log('Sessions table error:', e.message); }

  await p.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
