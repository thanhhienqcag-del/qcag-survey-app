// api/quotes.js — Vercel Serverless Function
// Routes: GET /api/quotes, POST /api/quotes, PATCH /api/quotes
'use strict';

const { query, withTransaction } = require('../db');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', (process.env.ALLOWED_ORIGINS || '*').trim());
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJson(res, status, data) {
  res.status(status).json(data);
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    switch (req.method) {
      case 'GET':   return await getQuotes(req, res);
      case 'POST':  return await createQuote(req, res);
      case 'PATCH': return await updateQuote(req, res);
      default:
        return sendJson(res, 405, { error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('[quotes] Unhandled error:', err);
    return sendJson(res, 500, { error: 'Internal server error' });
  }
};

// ── GET /api/quotes?project_id=123 ────────────────────────────────────
async function getQuotes(req, res) {
  const { project_id, id } = req.query;

  if (id) {
    const { rows } = await query('SELECT * FROM quotes WHERE id = $1', [id]);
    if (!rows.length) return sendJson(res, 404, { error: 'Quote not found' });
    return sendJson(res, 200, { data: rows[0] });
  }

  if (!project_id) return sendJson(res, 400, { error: '"project_id" là bắt buộc' });

  const { rows } = await query(
    'SELECT * FROM quotes WHERE project_id = $1 ORDER BY created_at DESC',
    [project_id],
  );
  return sendJson(res, 200, { data: rows });
}

// ── POST /api/quotes ──────────────────────────────────────────────────
// Body: { project_id, price, line_items?, quoted_by?, valid_until?, notes? }
async function createQuote(req, res) {
  const { project_id, price, line_items = [], quoted_by, valid_until, notes } = req.body || {};

  if (!project_id) return sendJson(res, 400, { error: '"project_id" là bắt buộc' });
  if (price === undefined || isNaN(Number(price))) {
    return sendJson(res, 400, { error: '"price" phải là số hợp lệ' });
  }

  // Kiểm tra project tồn tại và có status phù hợp
  const { rows: projectRows } = await query(
    'SELECT id, status FROM projects WHERE id = $1', [project_id],
  );
  if (!projectRows.length) return sendJson(res, 404, { error: 'Project not found' });

  const projectStatus = projectRows[0].status;
  if (!['ready_for_quote', 'quoted'].includes(projectStatus)) {
    return sendJson(res, 400, {
      error: `Project có status "${projectStatus}" chưa sẵn sàng để báo giá. Cần status "ready_for_quote".`,
    });
  }

  const { rows } = await withTransaction(async (client) => {
    const r = await client.query(
      `INSERT INTO quotes (project_id, price, line_items, quoted_by, valid_until, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [project_id, Number(price), JSON.stringify(line_items), quoted_by || null, valid_until || null, notes || null],
    );
    // Cập nhật project status thành quoted
    await client.query(
      `UPDATE projects SET status = 'quoted' WHERE id = $1`,
      [project_id],
    );
    return r.rows;
  });

  return sendJson(res, 201, { data: rows[0], message: 'Quote created successfully' });
}

// ── PATCH /api/quotes ─────────────────────────────────────────────────
// Body: { id, status?, price?, notes? }
async function updateQuote(req, res) {
  const { id, status, price, notes } = req.body || {};
  if (!id) return sendJson(res, 400, { error: '"id" là bắt buộc' });

  const VALID_QUOTE_STATUSES = new Set(['draft', 'sent', 'accepted', 'rejected']);
  const setClauses = [];
  const params = [];

  if (status !== undefined) {
    if (!VALID_QUOTE_STATUSES.has(status)) {
      return sendJson(res, 400, { error: `Invalid quote status: ${status}` });
    }
    params.push(status); setClauses.push(`status = $${params.length}`);
  }
  if (price !== undefined) { params.push(Number(price)); setClauses.push(`price = $${params.length}`); }
  if (notes !== undefined) { params.push(notes); setClauses.push(`notes = $${params.length}`); }

  if (!setClauses.length) return sendJson(res, 400, { error: 'Không có trường nào được cập nhật' });

  params.push(id);
  const { rows } = await query(
    `UPDATE quotes SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params,
  );

  if (!rows.length) return sendJson(res, 404, { error: 'Quote not found' });
  return sendJson(res, 200, { data: rows[0], message: 'Quote updated successfully' });
}
