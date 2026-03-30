// api/health.js — Health check endpoint
'use strict';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const checks = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: {
      has_database_url: !!process.env.DATABASE_URL,
      has_gcs_bucket: !!process.env.GCS_BUCKET || !!process.env.GCLOUD_BUCKET,
      node_env: process.env.NODE_ENV || 'not set',
    }
  };

  // Check if critical modules can be loaded
  try { require('pg'); checks.module_pg = 'ok'; } catch(e) { checks.module_pg = 'MISSING: ' + e.message; }
  try { require('@google-cloud/storage'); checks.module_gcs = 'ok'; } catch(e) { checks.module_gcs = 'MISSING: ' + e.message; }
  try { require('./projects'); checks.module_projects = 'ok'; } catch(e) { checks.module_projects = 'LOAD ERROR: ' + e.message; }
  // Simulate calling projects handler
  try {
    const projectsHandler = require('./projects');
    const fakeReq = { method: 'GET', query: {} };
    const fakeRes = {
      _status: 200, _body: null,
      status(s) { this._status = s; return this; },
      json(b) { this._body = b; },
      setHeader() {},
      end() {}
    };
    await projectsHandler(fakeReq, fakeRes);
    checks.projects_handler = 'ok, status=' + fakeRes._status + ', rows=' + (fakeRes._body && fakeRes._body.data ? fakeRes._body.data.length : JSON.stringify(fakeRes._body));
  } catch(e) { checks.projects_handler = 'HANDLER ERROR: ' + e.message; }

  // Try a quick DB ping
  try {
    const { query } = require('../db');
    await query('SELECT 1 AS ping');
    checks.database = 'connected';
    // Try to query projects table
    try {
      const r = await query('SELECT COUNT(*) FROM projects');
      checks.projects_table = 'ok, rows: ' + r.rows[0].count;
    } catch (e2) {
      checks.projects_table = 'error: ' + e2.message;
    }
    // Try the actual projects query
    try {
      const r2 = await query(
        `SELECT p.*, COUNT(s.id) AS survey_count, COUNT(q.id) AS quote_count
         FROM projects p
         LEFT JOIN surveys s ON s.project_id = p.id
         LEFT JOIN quotes  q ON q.project_id = p.id
         GROUP BY p.id
         ORDER BY p.created_at DESC`
      );
      checks.projects_query = 'ok, rows: ' + r2.rowCount;
    } catch (e3) {
      checks.projects_query = 'error: ' + e3.message;
    }
  } catch (err) {
    checks.database = 'error: ' + err.message;
  }

  res.status(200).json(checks);
};
