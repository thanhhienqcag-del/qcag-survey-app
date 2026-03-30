/**
 * scripts/import-csv-to-neon.js  v3
 *
 * Import Cloud SQL CSV exports into Neon PostgreSQL.
 * Uses a line-by-line state-machine CSV parser that handles:
 *  - MySQL NULL exported as bare N (unquoted)
 *  - Multiline fields (JSON with embedded newlines) — NOT present in this export
 *    because Cloud SQL CSV export uses single-line format
 *  - Double-quoted fields with "" escape
 *
 * Run: node scripts/import-csv-to-neon.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DATA_DIR = path.join(__dirname, 'data');

function buildPgConfig(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.delete('sslmode');
  url.searchParams.delete('channel_binding');
  return { connectionString: url.toString(), ssl: { rejectUnauthorized: false } };
}

const pool = new Pool(buildPgConfig(process.env.DATABASE_URL));
async function q(text, params) { return pool.query(text, params); }

// ── Column definitions (from INFORMATION_SCHEMA export) ───────────────
// Source: quotations_cols.csv — 43 columns
const COLS_QUOTATIONS = [
  'id','quote_code','images','qcag_image_url','qcag_override_status',
  'qcag_note','qcag_at','created_at','outlet_code','outlet_name','spo_name',
  'area','outlet_phone','sale_type','sale_code','sale_name','sale_phone',
  'ss_name','house_number','street','ward','district','province','address',
  'items','total_amount','spo_number','spo_status','notes','qcag_status',
  'qcag_order_number','order_number','updated_at','due_date','responsibles',
  'is_confirmed','last_confirmed_at','edit_history','is_exported',
  'exported_at','created_by','created_by_name','qc_signage_state',
];
// Note: cols.csv says 43 cols but CSV has 40 — some were added later.
// We detect actual field count from first row and trim COLS accordingly.

const COLS_PRODUCTION_ORDERS = ['id','items','quote_keys','spo_number','order_number','notes','created_at','updated_at','acceptanceImages'];
const COLS_INSPECTIONS      = ['id','quotation_id','status','note','created_at'];
const COLS_USERS             = ['id','username','name','password_hash','role','approved','created_at','updated_at'];
const COLS_QUOTE_SEQUENCES   = ['year','current_value','updated_at'];
const COLS_PENDING_ORDERS    = ['id','created_by','created_by_name','created_at','quotes','total_points','total_amount','updated_at'];

// ── CSV tokenizer ─────────────────────────────────────────────────────
/**
 * Parse a single CSV line into an array of values.
 * MySQL NULL = unquoted 'N' between commas.
 * Returns null for empty or MySQL-NULL fields.
 */
function parseCsvLine(line) {
  const fields = [];
  let i = 0;
  const len = line.length;

  while (i <= len) {
    if (i === len) { fields.push(null); break; }

    if (line[i] === '"') {
      // Quoted field
      i++;
      let val = '';
      while (i < len) {
        if (line[i] === '"') {
          if (i + 1 < len && line[i+1] === '"') { val += '"'; i += 2; }
          else { i++; break; }
        } else {
          val += line[i++];
        }
      }
      // After closing quote, skip optional trailing " or noise before comma
      while (i < len && line[i] !== ',') i++;
      fields.push(val === '' ? null : val);
      if (i < len && line[i] === ',') i++;
    } else {
      // Unquoted field — ends at comma or EOL
      let end = len;
      for (let j = i; j < len; j++) {
        if (line[j] === ',') { end = j; break; }
      }
      const raw = line.slice(i, end);
      // MySQL NULL = bare 'N'
      fields.push((raw === 'N' || raw === '') ? null : raw);
      i = end;
      if (i < len && line[i] === ',') i++;
    }
  }
  return fields;
}


function readCsv(file, expectedCols) {
  const filePath = path.join(DATA_DIR, file);
  if (!fs.existsSync(filePath)) { console.log(`  skip (not found): ${file}`); return []; }
  const raw = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!raw.trim()) { console.log(`  skip (empty): ${file}`); return []; }

  const lines = raw.split('\n').filter(l => l.trim());
  console.log(`  ${file}: ${lines.length} lines`);

  const rows = [];
  for (const line of lines) {
    const fields = parseCsvLine(line);
    // Map to object using expectedCols (trim to CSV actual field count)
    const obj = {};
    const useCols = expectedCols.slice(0, fields.length);
    useCols.forEach((col, idx) => { obj[col] = fields[idx]; });
    rows.push(obj);
  }
  return rows;
}

function toInt(val) {
  if (val == null) return 0;
  const n = parseInt(String(val).replace(/[^0-9-]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

function toFloat(val) {
  if (val == null) return null;
  const n = parseFloat(String(val));
  return isNaN(n) ? null : n;
}

function safeDate(val) {
  if (!val) return null;
  const d = new Date(String(val).replace(/"$/, '')); // strip trailing "
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ── Schema ─────────────────────────────────────────────────────────────
async function ensureSchema() {
  console.log('Creating/verifying schema...');
  await q(`
    CREATE TABLE IF NOT EXISTS quotations (
      id INTEGER PRIMARY KEY,
      quote_code VARCHAR(32) NOT NULL UNIQUE,
      outlet_code VARCHAR(64), outlet_name VARCHAR(255), spo_name VARCHAR(255),
      area VARCHAR(64), outlet_phone VARCHAR(128), sale_type VARCHAR(64),
      sale_code VARCHAR(64), sale_name VARCHAR(255), sale_phone VARCHAR(64),
      ss_name VARCHAR(255), house_number VARCHAR(128), street VARCHAR(255),
      ward VARCHAR(255), district VARCHAR(255), province VARCHAR(255),
      address TEXT, items TEXT, images TEXT, total_amount NUMERIC(15,2),
      spo_number VARCHAR(64), spo_status TEXT, notes TEXT,
      qcag_status VARCHAR(64), qcag_order_number VARCHAR(64), order_number VARCHAR(64),
      qcag_image_url TEXT, qcag_override_status TEXT, qcag_note TEXT,
      qcag_at TIMESTAMPTZ, due_date TEXT, responsibles TEXT,
      is_confirmed INTEGER NOT NULL DEFAULT 0, last_confirmed_at TEXT,
      edit_history TEXT, is_exported INTEGER NOT NULL DEFAULT 0, exported_at TEXT,
      created_by VARCHAR(128), created_by_name VARCHAR(255), qc_signage_state TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ
    )`);
  await q(`
    CREATE TABLE IF NOT EXISTS production_orders (
      id INTEGER PRIMARY KEY, items TEXT, quote_keys TEXT,
      spo_number VARCHAR(64), order_number VARCHAR(64), notes TEXT,
      acceptance_images TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ
    )`);
  await q(`
    CREATE TABLE IF NOT EXISTS inspections (
      id INTEGER PRIMARY KEY, quotation_id INTEGER NOT NULL,
      status VARCHAR(32) DEFAULT 'binh_thuong', note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, username VARCHAR(64) NOT NULL UNIQUE,
      name VARCHAR(255), password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(16) NOT NULL DEFAULT 'user', approved INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ
    )`);
  await q(`
    CREATE TABLE IF NOT EXISTS quote_sequences (
      year CHAR(2) PRIMARY KEY, current_value INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ
    )`);
  await q(`
    CREATE TABLE IF NOT EXISTS pending_orders (
      id VARCHAR(64) PRIMARY KEY, created_by VARCHAR(255), created_by_name VARCHAR(255),
      created_at BIGINT NOT NULL, quotes TEXT, total_points INTEGER DEFAULT 0,
      total_amount NUMERIC(15,2) DEFAULT 0, updated_at TIMESTAMPTZ
    )`);

  // Fix existing columns that might be wrong type
  const fixes = [
    `ALTER TABLE quotations ALTER COLUMN spo_status TYPE TEXT`,
    `ALTER TABLE quotations ALTER COLUMN address TYPE TEXT`,
    `ALTER TABLE quotations ALTER COLUMN images TYPE TEXT`,
    `ALTER TABLE quotations ALTER COLUMN qcag_image_url TYPE TEXT`,
    `ALTER TABLE quotations ALTER COLUMN outlet_phone TYPE VARCHAR(128)`,
    `ALTER TABLE quotations ALTER COLUMN house_number TYPE VARCHAR(128)`,
    `ALTER TABLE quotations ALTER COLUMN created_by TYPE VARCHAR(128)`,
    `ALTER TABLE quotations ALTER COLUMN is_confirmed TYPE INTEGER USING is_confirmed::INTEGER`,
    `ALTER TABLE quotations ALTER COLUMN is_exported TYPE INTEGER USING is_exported::INTEGER`,
  ];
  for (const fix of fixes) {
    await q(fix).catch(() => {}); // ignore if already correct type
  }
  console.log('Schema OK\n');
}

// ── Importers ─────────────────────────────────────────────────────────
async function importQuotations() {
  console.log('Importing quotations...');
  const rows = readCsv('quotations.csv', COLS_QUOTATIONS);
  let ok = 0, skip = 0, errors = 0;
  for (const r of rows) {
    if (!r.id || !r.quote_code) { skip++; continue; }
    try {
      await q(`
        INSERT INTO quotations (
          id,quote_code,images,qcag_image_url,qcag_override_status,
          qcag_note,qcag_at,created_at,outlet_code,outlet_name,spo_name,
          area,outlet_phone,sale_type,sale_code,sale_name,sale_phone,
          ss_name,house_number,street,ward,district,province,address,
          items,total_amount,spo_number,spo_status,notes,qcag_status,
          qcag_order_number,order_number,updated_at,due_date,responsibles,
          is_confirmed,last_confirmed_at,edit_history,is_exported,
          exported_at,created_by,created_by_name,qc_signage_state
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
          $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,
          $33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43
        )
        ON CONFLICT (quote_code) DO UPDATE SET
          images=EXCLUDED.images, qcag_status=EXCLUDED.qcag_status,
          qcag_image_url=EXCLUDED.qcag_image_url, items=EXCLUDED.items,
          total_amount=EXCLUDED.total_amount, updated_at=EXCLUDED.updated_at,
          spo_status=EXCLUDED.spo_status, notes=EXCLUDED.notes,
          qcag_note=EXCLUDED.qcag_note, qcag_at=EXCLUDED.qcag_at
      `, [
        toInt(r.id), r.quote_code,
        r.images, r.qcag_image_url, r.qcag_override_status,
        r.qcag_note, safeDate(r.qcag_at), safeDate(r.created_at),
        r.outlet_code, r.outlet_name, r.spo_name, r.area, r.outlet_phone,
        r.sale_type, r.sale_code, r.sale_name, r.sale_phone,
        r.ss_name, r.house_number, r.street, r.ward, r.district, r.province,
        r.address, r.items, toFloat(r.total_amount),
        r.spo_number, r.spo_status, r.notes, r.qcag_status,
        r.qcag_order_number, r.order_number,
        safeDate(r.updated_at), r.due_date, r.responsibles,
        toInt(r.is_confirmed), r.last_confirmed_at, r.edit_history,
        toInt(r.is_exported), r.exported_at,
        r.created_by, r.created_by_name, r.qc_signage_state,
      ]);
      ok++;
      if (ok % 200 === 0) process.stdout.write(`  ${ok}...\r`);
    } catch (e) {
      errors++;
      if (errors <= 3) console.error(`  ERR row ${r.id}: ${e.message.slice(0, 120)}`);
    }
  }
  console.log(`  quotations: ${ok} ok, ${skip} skipped, ${errors} errors`);
}

async function importProductionOrders() {
  console.log('Importing production_orders...');
  const rows = readCsv('production_orders.csv', COLS_PRODUCTION_ORDERS);
  let ok = 0;
  for (const r of rows) {
    if (!r.id) continue;
    try {
      await q(`INSERT INTO production_orders (id,items,quote_keys,spo_number,order_number,notes,acceptance_images,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [toInt(r.id), r.items, r.quote_keys, r.spo_number, r.order_number,
         r.notes, r.acceptanceImages, safeDate(r.created_at), safeDate(r.updated_at)]);
      ok++;
    } catch (e) { console.error(`  ERR: ${e.message.slice(0,80)}`); }
  }
  console.log(`  production_orders: ${ok}`);
}

async function importInspections() {
  console.log('Importing inspections...');
  const rows = readCsv('inspections.csv', COLS_INSPECTIONS);
  if (!rows.length) { console.log('  (no data)'); return; }
  let ok = 0;
  for (const r of rows) {
    if (!r.id) continue;
    try {
      await q(`INSERT INTO inspections (id,quotation_id,status,note,created_at)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
        [toInt(r.id), toInt(r.quotation_id), r.status || 'binh_thuong', r.note, safeDate(r.created_at)]);
      ok++;
    } catch (e) { console.error(`  ERR: ${e.message.slice(0,80)}`); }
  }
  console.log(`  inspections: ${ok}`);
}

async function importUsers() {
  console.log('Importing users...');
  const rows = readCsv('users.csv', COLS_USERS);
  let ok = 0;
  for (const r of rows) {
    if (!r.username) continue;
    try {
      await q(`INSERT INTO users (id,username,name,password_hash,role,approved,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (username) DO UPDATE SET name=EXCLUDED.name,
          password_hash=EXCLUDED.password_hash, role=EXCLUDED.role,
          approved=EXCLUDED.approved, updated_at=EXCLUDED.updated_at`,
        [toInt(r.id), r.username, r.name, r.password_hash,
         r.role || 'user', toInt(r.approved), safeDate(r.created_at), safeDate(r.updated_at)]);
      ok++;
    } catch (e) { console.error(`  ERR: ${e.message.slice(0,80)}`); }
  }
  console.log(`  users: ${ok}`);
}

async function importQuoteSequences() {
  console.log('Importing quote_sequences...');
  const rows = readCsv('quote_sequences.csv', COLS_QUOTE_SEQUENCES);
  let ok = 0;
  for (const r of rows) {
    if (!r.year) continue;
    try {
      await q(`INSERT INTO quote_sequences (year,current_value,updated_at) VALUES ($1,$2,$3)
        ON CONFLICT (year) DO UPDATE SET current_value=EXCLUDED.current_value, updated_at=EXCLUDED.updated_at`,
        [r.year, toInt(r.current_value), safeDate(r.updated_at)]);
      ok++;
    } catch (e) { console.error(`  ERR: ${e.message.slice(0,80)}`); }
  }
  console.log(`  quote_sequences: ${ok}`);
}

async function importPendingOrders() {
  console.log('Importing pending_orders...');
  const rows = readCsv('pending_orders.csv', COLS_PENDING_ORDERS);
  let ok = 0;
  for (const r of rows) {
    if (!r.id) continue;
    const createdAt = r.created_at ? String(r.created_at) : String(Date.now());
    try {
      await q(`INSERT INTO pending_orders (id,created_by,created_by_name,created_at,quotes,total_points,total_amount,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (id) DO UPDATE SET quotes=EXCLUDED.quotes,
          total_points=EXCLUDED.total_points, total_amount=EXCLUDED.total_amount,
          updated_at=EXCLUDED.updated_at`,
        [r.id, r.created_by, r.created_by_name, createdAt, r.quotes,
         toInt(r.total_points), toFloat(r.total_amount),
         r.updated_at ? safeDate(r.updated_at) : null]);
      ok++;
    } catch (e) { console.error(`  ERR ${r.id}: ${e.message.slice(0,80)}`); }
  }
  console.log(`  pending_orders: ${ok}`);
}

async function main() {
  console.log('=== Cloud SQL CSV -> Neon PostgreSQL (v3) ===\n');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');

  await ensureSchema();
  await importQuotations();
  await importProductionOrders();
  await importInspections();
  await importUsers();
  await importQuoteSequences();
  await importPendingOrders();

  console.log('\n--- Final row counts ---');
  for (const t of ['quotations','production_orders','inspections','users','quote_sequences','pending_orders']) {
    const res = await q(`SELECT COUNT(*) n FROM ${t}`).catch(() => ({rows:[{n:'?'}]}));
    console.log(`  ${t}: ${res.rows[0].n}`);
  }
  console.log('\nDone!');
}

main()
  .catch(e => { console.error('FAILED:', e.message); process.exit(1); })
  .finally(() => pool.end().catch(()=>{}));
