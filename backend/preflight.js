/*
  Preflight checks for QCAG backend deployment.

  Goal:
  - Validate required environment variables are present
  - Verify MySQL connectivity (Cloud SQL socket or TCP)
  - Verify GCS bucket access using Application Default Credentials

  Usage:
    node preflight.js

  Exit codes:
    0 = all checks ok
    1 = one or more checks failed
*/

'use strict';

const mysql = require('mysql2/promise');
const { Storage } = require('@google-cloud/storage');

function boolEnv(name) {
  const v = process.env[name];
  if (v == null) return false;
  return String(v).trim() === '1' || String(v).trim().toLowerCase() === 'true';
}

function isCloudRun() {
  return !!process.env.K_SERVICE;
}

function mask(value) {
  if (value == null) return '';
  const s = String(value);
  if (s.length <= 4) return '****';
  return s.slice(0, 2) + '****' + s.slice(-2);
}

function printEnvSummary() {
  const cloudRun = isCloudRun();
  const cloudSql = String(process.env.CLOUD_SQL_CONNECTION_NAME || '').trim();

  console.log('=== QCAG Preflight ===');
  console.log('Mode:', cloudRun ? 'Cloud Run detected (K_SERVICE set)' : 'Not Cloud Run (local/VM)');
  console.log('DB:', cloudRun && cloudSql ? `Cloud SQL socket: /cloudsql/${cloudSql}` : `TCP host: ${process.env.DB_HOST || '(not set)'}:${process.env.DB_PORT || 3306}`);
  console.log('DB user:', process.env.DB_USER ? mask(process.env.DB_USER) : '(not set)');
  console.log('DB name:', process.env.DB_NAME ? process.env.DB_NAME : '(not set)');
  console.log('GCS_BUCKET:', process.env.GCS_BUCKET ? process.env.GCS_BUCKET : '(not set)');
  if (!cloudRun) {
    console.log('GOOGLE_APPLICATION_CREDENTIALS:', process.env.GOOGLE_APPLICATION_CREDENTIALS ? '(set)' : '(not set)');
  }
  console.log('======================');
}

function collectMissingEnv() {
  const missing = [];
  const cloudRun = isCloudRun();
  const cloudSql = String(process.env.CLOUD_SQL_CONNECTION_NAME || '').trim();

  if (!process.env.DB_USER) missing.push('DB_USER');
  if (!process.env.DB_PASSWORD) missing.push('DB_PASSWORD');
  if (!process.env.DB_NAME) missing.push('DB_NAME');

  // For non-Cloud Run, or Cloud Run without socket config, require DB_HOST.
  if (!(cloudRun && cloudSql)) {
    if (!process.env.DB_HOST) missing.push('DB_HOST');
  }

  if (!process.env.GCS_BUCKET) missing.push('GCS_BUCKET');

  return missing;
}

function getMysqlOptions() {
  const cloudRun = isCloudRun();
  const cloudSql = String(process.env.CLOUD_SQL_CONNECTION_NAME || '').trim();

  const base = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS || 10000),
    // mysql2 supports enableKeepAlive in connection options
    enableKeepAlive: true,
  };

  if (cloudRun && cloudSql) {
    return {
      ...base,
      socketPath: `/cloudsql/${cloudSql}`,
    };
  }

  return {
    ...base,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
  };
}

async function checkDb() {
  const opts = getMysqlOptions();
  const conn = await mysql.createConnection(opts);
  try {
    const [rows] = await conn.query('SELECT 1 AS ok');
    return { ok: true, rows };
  } finally {
    try {
      await conn.end();
    } catch (_) {}
  }
}

async function checkGcs() {
  const bucketName = String(process.env.GCS_BUCKET || '').trim();
  const storage = new Storage();
  const bucket = storage.bucket(bucketName);

  const [exists] = await bucket.exists();
  if (!exists) {
    const err = new Error('Bucket does not exist or access denied');
    err.code = 'GCS_BUCKET_NOT_FOUND_OR_DENIED';
    throw err;
  }

  // Verify we can list at least 1 object (read permission). Avoid printing object names.
  const [files] = await bucket.getFiles({ maxResults: 1, prefix: 'quote-images/' });
  return { ok: true, canList: true, sampleCount: Array.isArray(files) ? files.length : 0 };
}

async function main() {
  printEnvSummary();

  const missing = collectMissingEnv();
  if (missing.length) {
    console.error('Missing required env vars:', missing.join(', '));
    process.exitCode = 1;
    return;
  }

  const failFast = boolEnv('PREFLIGHT_FAIL_FAST');
  let hadError = false;

  // DB
  try {
    console.log('[DB] Checking MySQL connectivity...');
    await checkDb();
    console.log('[DB] OK');
  } catch (err) {
    hadError = true;
    console.error('[DB] FAILED:', err && err.message ? err.message : String(err));
    if (failFast) {
      process.exitCode = 1;
      return;
    }
  }

  // GCS
  try {
    console.log('[GCS] Checking bucket access...');
    const r = await checkGcs();
    console.log(`[GCS] OK (list check, sampleCount=${r.sampleCount})`);
  } catch (err) {
    hadError = true;
    console.error('[GCS] FAILED:', err && err.message ? err.message : String(err));
    if (failFast) {
      process.exitCode = 1;
      return;
    }
  }

  process.exitCode = hadError ? 1 : 0;
}

main().catch((err) => {
  console.error('Preflight crashed:', err && err.message ? err.message : String(err));
  process.exitCode = 1;
});
