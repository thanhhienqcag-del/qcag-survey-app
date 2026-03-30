// drop-recreate-quotations.js
require('dotenv').config();
const { Pool } = require('pg');

function buildPgConfig(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.delete('sslmode');
  url.searchParams.delete('channel_binding');
  return { connectionString: url.toString(), ssl: { rejectUnauthorized: false } };
}

const pool = new Pool(buildPgConfig(process.env.DATABASE_URL));

async function main() {
  console.log('Dropping and recreating all tables with correct types...');
  
  await pool.query('DROP TABLE IF EXISTS quotations CASCADE');
  await pool.query('DROP TABLE IF EXISTS production_orders CASCADE');
  await pool.query('DROP TABLE IF EXISTS inspections CASCADE');
  await pool.query('DROP TABLE IF EXISTS users CASCADE');
  await pool.query('DROP TABLE IF EXISTS quote_sequences CASCADE');
  await pool.query('DROP TABLE IF EXISTS pending_orders CASCADE');
  console.log('Dropped all tables');

  await pool.query(`
    CREATE TABLE quotations (
      id INTEGER PRIMARY KEY,
      quote_code VARCHAR(32) NOT NULL UNIQUE,
      outlet_code VARCHAR(128), outlet_name TEXT, spo_name TEXT,
      area VARCHAR(64), outlet_phone TEXT, sale_type VARCHAR(64),
      sale_code VARCHAR(128), sale_name TEXT, sale_phone VARCHAR(64),
      ss_name TEXT, house_number TEXT, street TEXT,
      ward TEXT, district TEXT, province TEXT,
      address TEXT, items TEXT, images TEXT, total_amount NUMERIC(15,2),
      spo_number VARCHAR(128), spo_status TEXT, notes TEXT,
      qcag_status VARCHAR(64), qcag_order_number VARCHAR(128), order_number VARCHAR(128),
      qcag_image_url TEXT, qcag_override_status TEXT, qcag_note TEXT,
      qcag_at TIMESTAMPTZ, due_date TEXT, responsibles TEXT,
      is_confirmed INTEGER NOT NULL DEFAULT 0, last_confirmed_at TEXT,
      edit_history TEXT, is_exported INTEGER NOT NULL DEFAULT 0, exported_at TEXT,
      created_by TEXT, created_by_name TEXT, qc_signage_state TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE TABLE production_orders (
      id INTEGER PRIMARY KEY, items TEXT, quote_keys TEXT,
      spo_number TEXT, order_number TEXT, notes TEXT,
      acceptance_images TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE TABLE inspections (
      id INTEGER PRIMARY KEY, quotation_id INTEGER NOT NULL,
      status VARCHAR(32) DEFAULT 'binh_thuong', note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, username VARCHAR(64) NOT NULL UNIQUE,
      name TEXT, password_hash TEXT NOT NULL,
      role VARCHAR(16) NOT NULL DEFAULT 'user', approved INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE TABLE quote_sequences (
      year CHAR(2) PRIMARY KEY, current_value INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE TABLE pending_orders (
      id VARCHAR(128) PRIMARY KEY, created_by TEXT, created_by_name TEXT,
      created_at BIGINT NOT NULL, quotes TEXT, total_points INTEGER DEFAULT 0,
      total_amount NUMERIC(15,2) DEFAULT 0, updated_at TIMESTAMPTZ
    )
  `);
  
  console.log('All tables created with correct types');
  await pool.end();
}

main().catch(e => { console.error(e.message); pool.end(); });
