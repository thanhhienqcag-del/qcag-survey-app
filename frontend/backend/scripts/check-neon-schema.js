const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://neondb_owner:npg_tC3ymrsEYQk2@ep-floral-pine-a18w14pz-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require' });

async function main() {
  const tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name");
  console.log('Tables on Neon:', tables.rows.map(r => r.table_name).join(', '));
  
  for (const row of tables.rows) {
    const t = row.table_name;
    const cols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position", [t]);
    console.log(t + ' cols: ' + cols.rows.map(r => r.column_name).join(', '));
  }
  
  await pool.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
