// db.js — PostgreSQL connection pool (Neon / any pg-compatible host)
// Tối ưu cho môi trường serverless: pool nhỏ, SSL luôn bật.
'use strict';

const { Pool } = require('pg');

// Lazy init: pool được tạo lần đầu khi query() được gọi (runtime, không phải build time)
let _pool = null;

function buildPoolConfig(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.delete('sslmode');
  url.searchParams.delete('channel_binding');
  return {
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  };
}

function getPool() {
  if (_pool) return _pool;
  if (!process.env.DATABASE_URL) {
    throw new Error('[db] DATABASE_URL environment variable is not set.');
  }
  _pool = new Pool(buildPoolConfig(process.env.DATABASE_URL));
  _pool.on('error', (err) => {
    console.error('[db] Unexpected pool error:', err.message);
    _pool = null; // reset để tạo lại lần sau
  });
  return _pool;
}

/**
 * Chạy một câu query đơn giản (không cần transaction).
 * @param {string} text  SQL query với $1, $2, ... placeholder
 * @param {any[]}  [params]
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const res = await getPool().query(text, params);
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[db] query (${Date.now() - start}ms) rows=${res.rowCount}`);
    }
    return res;
  } catch (err) {
    console.error('[db] Query error:', err.message, '\nSQL:', text);
    throw err;
  }
}

async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { query, withTransaction, get pool() { return getPool(); } };
