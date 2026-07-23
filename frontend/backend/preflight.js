/*
  Preflight checks for QCAG backend deployment.

  Goal:
  - Validate required environment variables are present (DATABASE_URL, GCS_BUCKET)
  - Verify PostgreSQL (Neon) connectivity
  - Verify GCS bucket access using Application Default Credentials

  Usage:
    node preflight.js

  Exit codes:
    0 = all checks ok
    1 = one or more checks failed
*/

'use strict';

if (!process.env.K_SERVICE) {
  try {
    require('dotenv').config();
  } catch (_) {}
}

const { Pool } = require('pg');
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
  if (s.length <= 15) return '****';
  try {
    const url = new URL(s);
    if (url.password) {
      url.password = '****';
    }
    return url.toString();
  } catch (_) {
    return s.slice(0, 10) + '****' + s.slice(-5);
  }
}

function printEnvSummary() {
  const cloudRun = isCloudRun();

  console.log('=== QCAG Preflight (PostgreSQL/Neon) ===');
  console.log('Mode:', cloudRun ? 'Cloud Run detected (K_SERVICE set)' : 'Not Cloud Run (local/VM)');
  console.log('DATABASE_URL:', process.env.DATABASE_URL ? mask(process.env.DATABASE_URL) : '(not set)');
  console.log('GCS_BUCKET:', process.env.GCS_BUCKET ? process.env.GCS_BUCKET : '(not set)');
  if (!cloudRun) {
    console.log('GOOGLE_APPLICATION_CREDENTIALS:', process.env.GOOGLE_APPLICATION_CREDENTIALS ? '(set)' : '(not set)');
  }
  console.log('=======================================');
}

function collectMissingEnv() {
  const missing = [];
  if (!process.env.DATABASE_URL) missing.push('DATABASE_URL');
  if (!process.env.GCS_BUCKET) missing.push('GCS_BUCKET');
  return missing;
}

async function checkDb() {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error('DATABASE_URL environment variable is not set');

  const pool = new Pool({
    connectionString: rawUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000,
  });
  try {
    const res = await pool.query('SELECT 1 AS ok');
    return { ok: true, rows: res.rows };
  } finally {
    try {
      await pool.end();
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

  // Verify we can list at least 1 object
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
    console.log('[DB] Checking PostgreSQL (Neon) connectivity...');
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