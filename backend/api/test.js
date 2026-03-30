'use strict';
// Minimal test: no DB, no imports, just return JSON
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, method: req.method, query: req.query }));
};
