// api/orders.js — Vercel Serverless Function
// Routes: GET /api/orders, POST /api/orders, PATCH /api/orders
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

const VALID_ORDER_STATUSES = new Set([
  'pending', 'confirmed', 'in_progress', 'completed', 'cancelled',
]);

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    switch (req.method) {
      case 'GET':   return await getOrders(req, res);
      case 'POST':  return await createOrder(req, res);
      case 'PATCH': return await updateOrder(req, res);
      default:
        return sendJson(res, 405, { error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('[orders] Unhandled error:', err);
    return sendJson(res, 500, { error: 'Internal server error' });
  }
};

// ── GET /api/orders ───────────────────────────────────────────────────
async function getOrders(req, res) {
  const { project_id, id, status } = req.query;

  if (id) {
    const { rows } = await query(
      `SELECT o.*, p.name AS project_name, p.outlet_code, p.status AS project_status
       FROM orders o JOIN projects p ON p.id = o.project_id
       WHERE o.id = $1`,
      [id],
    );
    if (!rows.length) return sendJson(res, 404, { error: 'Order not found' });
    return sendJson(res, 200, { data: rows[0] });
  }

  const params = [];
  const conditions = [];

  if (project_id) { params.push(project_id); conditions.push(`o.project_id = $${params.length}`); }
  if (status) {
    if (!VALID_ORDER_STATUSES.has(status)) {
      return sendJson(res, 400, { error: `Invalid order status: ${status}` });
    }
    params.push(status); conditions.push(`o.status = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await query(
    `SELECT o.*, p.name AS project_name, p.outlet_code
     FROM orders o JOIN projects p ON p.id = o.project_id
     ${where}
     ORDER BY o.created_at DESC`,
    params,
  );
  return sendJson(res, 200, { data: rows });
}

// ── POST /api/orders ──────────────────────────────────────────────────
// Body: { project_id, quote_id?, assigned_to?, scheduled_at?, notes? }
async function createOrder(req, res) {
  const { project_id, quote_id, assigned_to, scheduled_at, notes } = req.body || {};

  if (!project_id) return sendJson(res, 400, { error: '"project_id" là bắt buộc' });

  // Kiểm tra project ở trạng thái có thể tạo order
  const { rows: projectRows } = await query(
    'SELECT id, status FROM projects WHERE id = $1', [project_id],
  );
  if (!projectRows.length) return sendJson(res, 404, { error: 'Project not found' });

  const projectStatus = projectRows[0].status;
  if (!['quoted', 'in_progress'].includes(projectStatus)) {
    return sendJson(res, 400, {
      error: `Project cần status "quoted" để tạo order. Hiện tại: "${projectStatus}"`,
    });
  }

  const { rows } = await withTransaction(async (client) => {
    const r = await client.query(
      `INSERT INTO orders (project_id, quote_id, assigned_to, scheduled_at, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [project_id, quote_id || null, assigned_to || null, scheduled_at || null, notes || null],
    );
    // Cập nhật project sang in_progress khi order được tạo
    await client.query(
      `UPDATE projects SET status = 'in_progress' WHERE id = $1`,
      [project_id],
    );
    return r.rows;
  });

  return sendJson(res, 201, { data: rows[0], message: 'Order created successfully' });
}

// ── PATCH /api/orders ─────────────────────────────────────────────────
// Body: { id, status?, assigned_to?, notes? }
async function updateOrder(req, res) {
  const { id, status, assigned_to, notes } = req.body || {};
  if (!id) return sendJson(res, 400, { error: '"id" là bắt buộc' });

  const setClauses = [];
  const params = [];

  if (status !== undefined) {
    if (!VALID_ORDER_STATUSES.has(status)) {
      return sendJson(res, 400, { error: `Invalid status: ${status}` });
    }
    params.push(status); setClauses.push(`status = $${params.length}`);

    // Nếu completed → cập nhật completed_at
    if (status === 'completed') {
      params.push(new Date().toISOString());
      setClauses.push(`completed_at = $${params.length}`);
    }
  }
  if (assigned_to !== undefined) { params.push(assigned_to); setClauses.push(`assigned_to = $${params.length}`); }
  if (notes !== undefined)        { params.push(notes);       setClauses.push(`notes = $${params.length}`); }

  if (!setClauses.length) return sendJson(res, 400, { error: 'Không có trường nào được cập nhật' });

  params.push(id);
  const { rows } = await query(
    `UPDATE orders SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params,
  );

  if (!rows.length) return sendJson(res, 404, { error: 'Order not found' });

  // Đồng bộ project status nếu order hoàn thành
  if (status === 'completed') {
    await query(`UPDATE projects SET status = 'done' WHERE id = $1`, [rows[0].project_id]);
  }

  return sendJson(res, 200, { data: rows[0], message: 'Order updated successfully' });
}
