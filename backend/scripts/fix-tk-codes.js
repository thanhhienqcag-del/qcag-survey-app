/**
 * fix-tk-codes.js
 * Resequence ALL tk_code values in ks_requests to eliminate duplicates.
 *
 * Rules:
 *   - Group rows by year (extracted from created_at)
 *   - Within each year, order by (created_at ASC, id ASC)
 *   - Assign TK{yy}.{seq:05d}  starting from TK{yy}.00001
 *
 * Safe to run multiple times (idempotent: checks before writing).
 *
 * Usage:
 *   node scripts/fix-tk-codes.js
 *   (DATABASE_URL must be set — copy .env.migrate to ../.env if needed)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  connectionTimeoutMillis: 10_000,
});

async function main() {
  console.log('Connecting to Neon DB...');

  // Fetch every row (id, tk_code, created_at) sorted so we can assign sequential codes
  const { rows } = await pool.query(
    `SELECT id, tk_code, created_at
       FROM ks_requests
      ORDER BY created_at ASC, id ASC`
  );

  console.log(`Fetched ${rows.length} row(s).`);
  if (rows.length === 0) {
    console.log('Nothing to do.');
    await pool.end();
    return;
  }

  // ── Group by calendar year ──────────────────────────────────────────
  const byYear = {};   // { '2026': [row, ...], ... }
  for (const row of rows) {
    const year = String(new Date(row.created_at).getFullYear());
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push(row);
  }

  // ── Build desired tk_code for every row ────────────────────────────
  const desired = new Map();   // id → newCode
  for (const [year, yearRows] of Object.entries(byYear)) {
    const yy = year.slice(-2);
    yearRows.forEach((row, idx) => {
      const seq     = String(idx + 1).padStart(5, '0');
      const newCode = `TK${yy}.${seq}`;
      desired.set(row.id, { oldCode: row.tk_code, newCode });
    });
  }

  // ── Identify rows that actually need updating ───────────────────────
  const toUpdate = [];
  for (const [id, { oldCode, newCode }] of desired.entries()) {
    if (oldCode !== newCode) toUpdate.push({ id, oldCode, newCode });
  }

  if (toUpdate.length === 0) {
    console.log('All tk_codes are already correct — no changes needed. ✅');
    await pool.end();
    return;
  }

  console.log(`\nPlanned changes (${toUpdate.length} row(s)):`);
  toUpdate.forEach(u => {
    console.log(`  id=${String(u.id).padStart(6)}  ${(u.oldCode || '(null)').padEnd(12)} → ${u.newCode}`);
  });

  // ── Step 1: NULL out only the rows we will touch ────────────────────
  // This avoids any transient UNIQUE-constraint conflicts if one exists,
  // because we overwrite values in a two-phase write.
  const ids = toUpdate.map(u => u.id);
  console.log(`\nStep 1: Clearing tk_code for ${ids.length} row(s) temporarily...`);
  await pool.query(
    `UPDATE ks_requests SET tk_code = NULL WHERE id = ANY($1::int[])`,
    [ids]
  );

  // ── Step 2: Write new codes ─────────────────────────────────────────
  console.log('Step 2: Assigning new tk_codes...');
  for (const { id, newCode } of toUpdate) {
    await pool.query(
      `UPDATE ks_requests SET tk_code = $1 WHERE id = $2`,
      [newCode, id]
    );
  }

  console.log(`\nDone. Updated ${toUpdate.length} row(s).`);

  // ── Verify: no duplicates remain ────────────────────────────────────
  const { rows: dupes } = await pool.query(
    `SELECT tk_code, COUNT(*) AS cnt
       FROM ks_requests
      WHERE tk_code IS NOT NULL
      GROUP BY tk_code
     HAVING COUNT(*) > 1`
  );

  if (dupes.length > 0) {
    console.error('\nWARNING — duplicate tk_codes still present:');
    dupes.forEach(d => console.error(`  ${d.tk_code}  (${d.cnt} rows)`));
  } else {
    console.log('Verification: no duplicate tk_codes found. ✅');
  }

  // ── Print final mapping ──────────────────────────────────────────────
  const { rows: final } = await pool.query(
    `SELECT id, tk_code, created_at
       FROM ks_requests
      ORDER BY created_at ASC, id ASC`
  );
  console.log('\nFinal tk_code mapping:');
  final.forEach(r => {
    console.log(`  id=${String(r.id).padStart(6)}  ${(r.tk_code || '(null)').padEnd(12)}  ${r.created_at}`);
  });

  await pool.end();
}

main().catch(e => {
  console.error('Fatal error:', e.message || e);
  pool.end();
  process.exit(1);
});
