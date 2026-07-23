const express = require('express')
const http = require('http')
const https = require('https')
const selfsigned = require('selfsigned')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// ── Data store (backed by data.json, dùng cho local dev)
// Cấu trúc: { requests: [...] }
// ── NOTE: trong production dùng Cloud SQL MySQL qua backend Cloud Run
const DATA_FILE = path.join(__dirname, '..', 'data', 'data.json')
let _requests = []
try {
  const raw = fs.readFileSync(DATA_FILE, 'utf8')
  const parsed = raw ? JSON.parse(raw) : []
  _requests = Array.isArray(parsed) ? parsed : []
} catch (e) {
  _requests = []
}

function _persist() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(_requests, null, 2), 'utf8') } catch (e) { console.error('persist error:', e) }
}

let _nextId = (_requests.length > 0 ? Math.max(..._requests.map(r => r.id || 0)) : 0) + 1

const app = express()
app.use(express.json({ limit: '25mb' }))

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large' })
  next(err)
})

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

// ── /api/env (trả BACKEND_URL rỗng = same-origin)
app.get('/api/env', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
  res.end('window.__env = {"BACKEND_URL":""};')
})

// ── /api/ks/health
app.get('/api/ks/health', (req, res) => res.json({ ok: true, service: 'ks-mobile-local', ts: Date.now() }))

// ── /api/ks/requests  GET list
app.get('/api/ks/requests', (req, res) => {
  const sorted = [..._requests].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
  res.json({ ok: true, data: sorted })
})

// ── /api/ks/requests/:id  GET single
app.get('/api/ks/requests/:id', (req, res) => {
  const id = req.params.id
  const row = /^\d+$/.test(id)
    ? _requests.find(r => String(r.id) === id)
    : _requests.find(r => r.__backendId === id)
  if (!row) return res.status(404).json({ ok: false, error: 'not_found' })
  res.json({ ok: true, data: row })
})

// ── /api/ks/requests  POST create
app.post('/api/ks/requests', (req, res) => {
  const b = req.body || {}
  const now = new Date().toISOString()
  const record = Object.assign({}, b, {
    id: _nextId++,
    __backendId: b.__backendId || ('srv_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex')),
    createdAt: b.createdAt || now,
    updatedAt: now,
  })
  _requests.push(record)
  _persist()
  res.status(201).json({ ok: true, data: record })
})

// ── /api/ks/requests/:id  PATCH update
app.patch('/api/ks/requests/:id', (req, res) => {
  const id = req.params.id
  const idx = /^\d+$/.test(id)
    ? _requests.findIndex(r => String(r.id) === id)
    : _requests.findIndex(r => r.__backendId === id)
  if (idx === -1) return res.status(404).json({ ok: false, error: 'not_found' })
  _requests[idx] = Object.assign({}, _requests[idx], req.body || {}, { updatedAt: new Date().toISOString() })
  _persist()
  res.json({ ok: true, data: _requests[idx] })
})

// ── /api/ks/upload  POST (local dev: trả lại dataUrl vì không có GCS)
app.post('/api/ks/upload', (req, res) => {
  const { dataUrl, filename } = req.body || {}
  if (!dataUrl) return res.status(400).json({ ok: false, error: 'missing_dataUrl' })
  // Local dev: lưu inline, không upload lên GCS
  const url = dataUrl
  res.json({ ok: true, url, name: filename || 'local' })
})

// ── Legacy /data endpoint (backward compat)
app.get('/data', (req, res) => res.json(_requests))
app.post('/data', (req, res) => {
  if (!req.body || !Array.isArray(req.body)) return res.status(400).json({ error: 'Array body expected' })
  _requests = req.body
  _persist()
  res.json({ ok: true })
})

// ── /sync health probe
app.get('/sync', (req, res) => res.json({ ok: true, ts: Date.now() }))

// ── Serve static files từ app root (thư mục cha của server/)
app.use(express.static(path.join(__dirname, '..', '..')))

// ── TLS self-signed cho HTTPS (cần cho camera/clipboard API trên mobile)
const attrs = [{ name: 'commonName', value: 'ks-mobile-local' }]
const pems = selfsigned.generate(attrs, { days: 365 })

const ports = [3000, 3001]
ports.forEach((port) => {
  const server = https.createServer({ key: pems.private, cert: pems.cert }, app)
  server.listen(port, '0.0.0.0', () => console.log(`KS Mobile [HTTPS] https://0.0.0.0:${port}`))
})

const httpPort = 3002
http.createServer(app).listen(httpPort, '0.0.0.0', () => console.log(`KS Mobile [HTTP]  http://0.0.0.0:${httpPort}`))

