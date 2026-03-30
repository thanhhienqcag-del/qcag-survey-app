/**
 * fix-sequences.js
 * Fix missing SERIAL sequences on tables where id was created as plain INTEGER
 * (happens when initDB created schema before migration ran)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const tables = ['quotations', 'production_orders', 'inspections', 'users', 'pending_orders'];

async function fixSequences() {
  for (const table of tables) {
    const { rows } = await pool.query(
      `SELECT column_default FROM information_schema.columns WHERE table_name=$1 AND column_name='id'`,
      [table]
    );
    if (!rows.length) { console.log(`  ⏭  ${table}: table not found`); continue; }
    const def = rows[0].column_default;
    if (def && def.includes('nextval')) { console.log(`  ✅ ${table}: sequence OK`); continue; }

    const seqName = `${table}_id_seq`;
    console.log(`  🔧 ${table}: creating sequence ${seqName}...`);
    await pool.query(`CREATE SEQUENCE IF NOT EXISTS ${seqName}`);
    await pool.query(`ALTER TABLE ${table} ALTER COLUMN id SET DEFAULT nextval('${seqName}'::regclass)`);
    const { rows: maxRows } = await pool.query(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`);
    const max = maxRows[0].m;
    await pool.query(`SELECT setval('${seqName}', GREATEST($1, 1))`, [max]);
    console.log(`  ✅ ${table}: sequence set, next id = ${max + 1}`);
  }
}

fixSequences()
  .then(() => { console.log('\nDone.'); pool.end(); })
  .catch(e => { console.error(e.message); pool.end(); process.exit(1); });
