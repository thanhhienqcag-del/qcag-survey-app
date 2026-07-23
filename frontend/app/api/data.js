const fs = require('fs');
const path = require('path');

// NOTE: Vercel serverless filesystem is ephemeral. This simple implementation
// attempts to read/write `data.json` in the project root for convenience
// during short-lived testing. Data will not persist across cold starts or
// redeploys. For production use configure Supabase and set `SUPABASE_*` env vars.

const DATA_FILE = path.join(__dirname, '..', 'data.json');

let store = {};
try {
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  store = raw ? JSON.parse(raw) : {};
} catch (e) {
  store = {};
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(store);
  }

  if (req.method === 'POST') {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'JSON body expected' });
    store = req.body;
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
    } catch (e) {
      // ignore write errors; still respond ok so client can continue testing
      console.warn('Failed to persist data.json (ephemeral):', e);
    }
    return res.json({ ok: true });
  }

  res.setHeader('Allow', 'GET,POST');
  return res.status(405).end('Method Not Allowed');
};
