/**
 * scripts/migrate-from-cloudsql.js
 *
 * Xuất dữ liệu từ Google Cloud SQL (MySQL) sang Neon (PostgreSQL).
 *
 * Chạy lệnh:
 *   node scripts/migrate-from-cloudsql.js
 *
 * Yêu cầu:
 *   - Đặt MYSQL_* và DATABASE_URL trong .env hoặc biến môi trường
 *   - mysql2: npm install mysql2
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const { Pool } = require('pg');

// ── MySQL (Cloud SQL) config ──────────────────────────────────────────
const mysqlConfig = {
  host:     process.env.MYSQL_HOST     || '127.0.0.1',
  port:     Number(process.env.MYSQL_PORT) || 3306,
  user:     process.env.MYSQL_USER     || process.env.DB_USER,
  password: process.env.MYSQL_PASSWORD || process.env.DB_PASSWORD,
  database: process.env.MYSQL_DATABASE || process.env.DB_NAME,
  charset:  'utf8mb4',
  timezone: '+07:00',
};

// ── Neon (PostgreSQL) config ──────────────────────────────────────────
function buildPgConfig(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.delete('sslmode');
  url.searchParams.delete('channel_binding');
  return {
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: false },
  };
}

const pgPool = new Pool(buildPgConfig(process.env.DATABASE_URL));

// ── Helpers ────────────────────────────────────────────────────────────
function safeJson(val) {
  if (val == null) return null;
  if (typeof val === 'string') return val;
  return JSON.stringify(val);
}

function safeDate(val) {
  if (val == null) return null;
  if (val instanceof Date) return val.toISOString();
  return val;
}

async function pgQuery(text, params) {
  return pgPool.query(text, params);
}

// ── 1. Tạo schema tương đương trên Neon ───────────────────────────────
async function ensureSchema() {
  console.log('⏳ Creating schema on Neon...');
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS quotations (
      id            SERIAL PRIMARY KEY,
      quote_code    VARCHAR(32) NOT NULL UNIQUE,
      outlet_code   VARCHAR(64),
      outlet_name   VARCHAR(255),
      spo_name      VARCHAR(255),
      area          VARCHAR(64),
      outlet_phone  VARCHAR(64),
      sale_type     VARCHAR(64),
      sale_code     VARCHAR(64),
      sale_name     VARCHAR(255),
      sale_phone    VARCHAR(64),
      ss_name       VARCHAR(255),
      house_number  VARCHAR(64),
      street        VARCHAR(255),
      ward          VARCHAR(255),
      district      VARCHAR(255),
      province      VARCHAR(255),
      address       TEXT,
      items         TEXT,
      images        TEXT,
      total_amount  NUMERIC(15,2),
      spo_number    VARCHAR(64),
      spo_status    VARCHAR(255),
      notes         TEXT,
      qcag_status   VARCHAR(64),
      qcag_order_number VARCHAR(64),
      order_number  VARCHAR(64),
      qcag_image_url TEXT,
      qcag_override_status VARCHAR(30),
      qcag_note     TEXT,
      qcag_at       TIMESTAMPTZ,
      due_date      TEXT,
      responsibles  TEXT,
      is_confirmed  SMALLINT NOT NULL DEFAULT 0,
      last_confirmed_at TEXT,
      edit_history  TEXT,
      is_exported   SMALLINT NOT NULL DEFAULT 0,
      exported_at   TEXT,
      created_by    VARCHAR(64),
      created_by_name VARCHAR(255),
      qc_signage_state TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ
    )
  `);

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS production_orders (
      id            SERIAL PRIMARY KEY,
      items         TEXT,
      quote_keys    TEXT,
      spo_number    VARCHAR(64),
      order_number  VARCHAR(64),
      notes         TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ
    )
  `);

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS inspections (
      id              SERIAL PRIMARY KEY,
      quotation_id    INTEGER NOT NULL,
      status          VARCHAR(32) DEFAULT 'binh_thuong',
      note            TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      VARCHAR(64) NOT NULL UNIQUE,
      name          VARCHAR(255),
      password_hash VARCHAR(255) NOT NULL,
      role          VARCHAR(16) NOT NULL DEFAULT 'user',
      approved      SMALLINT NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ
    )
  `);

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS quote_sequences (
      year            CHAR(2) PRIMARY KEY,
      current_value   INTEGER NOT NULL DEFAULT 0,
      updated_at      TIMESTAMPTZ
    )
  `);

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS pending_orders (
      id              VARCHAR(64) PRIMARY KEY,
      created_by      VARCHAR(255),
      created_by_name VARCHAR(255),
      created_at      BIGINT NOT NULL,
      quotes          TEXT,
      total_points    INTEGER DEFAULT 0,
      total_amount    NUMERIC(15,2) DEFAULT 0,
      updated_at      TIMESTAMPTZ
    )
  `);

  console.log('✅ Schema ready on Neon');
}

// ── 2. Migrate từng bảng ──────────────────────────────────────────────
async function migrateQuotations(mysqlConn) {
  console.log('\n⏳ Migrating quotations...');
  const [rows] = await mysqlConn.query('SELECT * FROM quotations ORDER BY id');
  if (!rows.length) { console.log('   ⚠️  No rows'); return; }

  let count = 0;
  for (const r of rows) {
    await pgQuery(`
      INSERT INTO quotations (
        id, quote_code, outlet_code, outlet_name, spo_name, area,
        outlet_phone, sale_type, sale_code, sale_name, sale_phone, ss_name,
        house_number, street, ward, district, province, address,
        items, images, total_amount, spo_number, spo_status, notes,
        qcag_status, qcag_order_number, order_number, qcag_image_url,
        qcag_override_status, qcag_note, qcag_at,
        due_date, responsibles, is_confirmed, last_confirmed_at,
        edit_history, is_exported, exported_at, created_by, created_by_name,
        qc_signage_state, created_at, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
              $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,
              $35,$36,$37,$38,$39,$40,$41,$42,$43)
      ON CONFLICT (quote_code) DO UPDATE SET
        outlet_code=EXCLUDED.outlet_code, outlet_name=EXCLUDED.outlet_name,
        items=EXCLUDED.items, images=EXCLUDED.images,
        total_amount=EXCLUDED.total_amount, qcag_status=EXCLUDED.qcag_status,
        qcag_image_url=EXCLUDED.qcag_image_url, updated_at=EXCLUDED.updated_at
    `, [
      r.id, r.quote_code, r.outlet_code, r.outlet_name, r.spo_name, r.area,
      r.outlet_phone, r.sale_type, r.sale_code, r.sale_name, r.sale_phone, r.ss_name,
      r.house_number, r.street, r.ward, r.district, r.province, r.address,
      safeJson(r.items), safeJson(r.images), r.total_amount,
      r.spo_number, r.spo_status, r.notes,
      r.qcag_status, r.qcag_order_number, r.order_number, r.qcag_image_url,
      r.qcag_override_status, r.qcag_note, safeDate(r.qcag_at),
      r.due_date, safeJson(r.responsibles),
      r.is_confirmed ? 1 : 0, r.last_confirmed_at,
      safeJson(r.edit_history), r.is_exported ? 1 : 0, r.exported_at,
      r.created_by, r.created_by_name, safeJson(r.qc_signage_state),
      safeDate(r.created_at), safeDate(r.updated_at),
    ]);
    count++;
    if (count % 100 === 0) console.log(`   ${count}/${rows.length}...`);
  }

  // Sync sequence
  const maxId = Math.max(...rows.map(r => r.id));
  await pgQuery(`SELECT setval('quotations_id_seq', $1, true)`, [maxId]);
  console.log(`✅ quotations: ${count} rows`);
}

async function migrateProductionOrders(mysqlConn) {
  console.log('\n⏳ Migrating production_orders...');
  const [rows] = await mysqlConn.query('SELECT * FROM production_orders ORDER BY id');
  if (!rows.length) { console.log('   ⚠️  No rows'); return; }
  for (const r of rows) {
    await pgQuery(`
      INSERT INTO production_orders (id, items, quote_keys, spo_number, order_number, notes, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING
    `, [r.id, safeJson(r.items), safeJson(r.quote_keys), r.spo_number, r.order_number, r.notes,
        safeDate(r.created_at), safeDate(r.updated_at)]);
  }
  const maxId = Math.max(...rows.map(r => r.id));
  await pgQuery(`SELECT setval('production_orders_id_seq', $1, true)`, [maxId]);
  console.log(`✅ production_orders: ${rows.length} rows`);
}

async function migrateInspections(mysqlConn) {
  console.log('\n⏳ Migrating inspections...');
  const [rows] = await mysqlConn.query('SELECT * FROM inspections ORDER BY id');
  if (!rows.length) { console.log('   ⚠️  No rows'); return; }
  for (const r of rows) {
    await pgQuery(`
      INSERT INTO inspections (id, quotation_id, status, note, created_at)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING
    `, [r.id, r.quotation_id, r.status, r.note, safeDate(r.created_at)]);
  }
  const maxId = Math.max(...rows.map(r => r.id));
  await pgQuery(`SELECT setval('inspections_id_seq', $1, true)`, [maxId]);
  console.log(`✅ inspections: ${rows.length} rows`);
}

async function migrateUsers(mysqlConn) {
  console.log('\n⏳ Migrating users...');
  const [rows] = await mysqlConn.query('SELECT * FROM users ORDER BY id');
  if (!rows.length) { console.log('   ⚠️  No rows'); return; }
  for (const r of rows) {
    await pgQuery(`
      INSERT INTO users (id, username, name, password_hash, role, approved, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (username) DO UPDATE SET
        name=EXCLUDED.name, password_hash=EXCLUDED.password_hash,
        role=EXCLUDED.role, approved=EXCLUDED.approved, updated_at=EXCLUDED.updated_at
    `, [r.id, r.username, r.name, r.password_hash, r.role, r.approved ? 1 : 0,
        safeDate(r.created_at), safeDate(r.updated_at)]);
  }
  const maxId = Math.max(...rows.map(r => r.id));
  await pgQuery(`SELECT setval('users_id_seq', $1, true)`, [maxId]);
  console.log(`✅ users: ${rows.length} rows`);
}

async function migrateQuoteSequences(mysqlConn) {
  console.log('\n⏳ Migrating quote_sequences...');
  const [rows] = await mysqlConn.query('SELECT * FROM quote_sequences');
  if (!rows.length) { console.log('   ⚠️  No rows'); return; }
  for (const r of rows) {
    await pgQuery(`
      INSERT INTO quote_sequences (year, current_value, updated_at)
      VALUES ($1,$2,$3) ON CONFLICT (year) DO UPDATE SET
        current_value=EXCLUDED.current_value, updated_at=EXCLUDED.updated_at
    `, [r.year, r.current_value, safeDate(r.updated_at)]);
  }
  console.log(`✅ quote_sequences: ${rows.length} rows`);
}

async function migratePendingOrders(mysqlConn) {
  console.log('\n⏳ Migrating pending_orders...');
  const [rows] = await mysqlConn.query('SELECT * FROM pending_orders ORDER BY created_at');
  if (!rows.length) { console.log('   ⚠️  No rows'); return; }
  for (const r of rows) {
    await pgQuery(`
      INSERT INTO pending_orders (id, created_by, created_by_name, created_at, quotes, total_points, total_amount, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET
        quotes=EXCLUDED.quotes, total_points=EXCLUDED.total_points,
        total_amount=EXCLUDED.total_amount, updated_at=EXCLUDED.updated_at
    `, [r.id, r.created_by, r.created_by_name, r.created_at,
        safeJson(r.quotes), r.total_points, r.total_amount,
        r.updated_at ? safeDate(r.updated_at) : null]);
  }
  console.log(`✅ pending_orders: ${rows.length} rows`);
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Starting Cloud SQL → Neon migration\n');
  console.log('MySQL host:', mysqlConfig.host, '| DB:', mysqlConfig.database);
  console.log('Neon URL:', process.env.DATABASE_URL ? '(set)' : '(NOT SET!)');
  console.log('');

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  if (!mysqlConfig.user || !mysqlConfig.password) throw new Error('MYSQL_USER/MYSQL_PASSWORD is not set');

  const mysqlConn = await mysql.createConnection(mysqlConfig);
  console.log('✅ Connected to Cloud SQL (MySQL)\n');

  try {
    await ensureSchema();
    await migrateQuotations(mysqlConn);
    await migrateProductionOrders(mysqlConn);
    await migrateInspections(mysqlConn);
    await migrateUsers(mysqlConn);
    await migrateQuoteSequences(mysqlConn);
    await migratePendingOrders(mysqlConn);
    console.log('\n✅ Migration complete!');
  } finally {
    await mysqlConn.end();
    await pgPool.end();
  }
}

main().catch(err => {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
});
