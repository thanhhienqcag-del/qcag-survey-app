const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://neondb_owner:npg_tC3ymrsEYQk2@ep-floral-pine-a18w14pz-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require' });

async function main() {
  const tables = ['users','quote_sequences','quotations','production_orders','pending_orders','inspections'];
  
  console.log('=== Neon Data Verification ===\n');
  
  for (const t of tables) {
    const cnt = await pool.query(`SELECT COUNT(*) FROM ${t}`);
    console.log(`${t}: ${cnt.rows[0].count} rows`);
  }

  // Sample quotation
  console.log('\n--- Sample quotation (id=1) ---');
  const q = await pool.query('SELECT id, quote_code, outlet_name, sale_name, total_amount, qcag_status, created_at FROM quotations WHERE id=1');
  if (q.rows.length) console.log(JSON.stringify(q.rows[0], null, 2));
  
  // Latest quotation
  console.log('\n--- Latest quotation ---');
  const latest = await pool.query('SELECT id, quote_code, outlet_name, sale_name, total_amount, qcag_status, created_at FROM quotations ORDER BY id DESC LIMIT 1');
  if (latest.rows.length) console.log(JSON.stringify(latest.rows[0], null, 2));
  
  // Check for any NULL quote_codes
  const nullCodes = await pool.query("SELECT COUNT(*) FROM quotations WHERE quote_code IS NULL");
  console.log('\nQuotations with NULL quote_code:', nullCodes.rows[0].count);
  
  // Users
  console.log('\n--- Users ---');
  const users = await pool.query('SELECT id, username, name, role, approved FROM users');
  users.rows.forEach(u => console.log(`  [${u.id}] ${u.username} (${u.name}) - ${u.role} - approved:${u.approved}`));

  await pool.end();
  console.log('\nVerification done.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
