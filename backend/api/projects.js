// api/projects.js — Vercel Serverless Function
// Routes: GET /api/projects, POST /api/projects, PATCH /api/projects
'use strict';

const { query } = require('../db');

// Tập hợp status hợp lệ
const VALID_STATUSES = new Set([
  'pending', 'ready_for_quote', 'quoted', 'in_progress', 'done', 'cancelled',
]);

// ── CORS helper ───────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', (process.env.ALLOWED_ORIGINS || '*').trim());
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJson(res, status, data) {
  res.status(status).json(data);
}

// ── Main handler ──────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    switch (req.method) {
      case 'GET':    return await getProjects(req, res);
      case 'POST':   return await createProject(req, res);
      case 'PATCH':  return await updateProject(req, res);
      default:
        return sendJson(res, 405, { error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('[projects] Unhandled error:', err);
    return sendJson(res, 500, { error: 'Internal server error', detail: err.message });
  }
};

// ── GET /api/projects ─────────────────────────────────────────────────
// Query params: ?status=ready_for_quote  |  ?id=123
async function getProjects(req, res) {
  const { status, id } = req.query;

  if (id) {
    const { rows } = await query(
      `SELECT p.*,
              json_agg(DISTINCT s.*) FILTER (WHERE s.id IS NOT NULL)  AS surveys,
              json_agg(DISTINCT q.*) FILTER (WHERE q.id IS NOT NULL)  AS quotes,
              json_agg(DISTINCT o.*) FILTER (WHERE o.id IS NOT NULL)  AS orders
       FROM projects p
       LEFT JOIN surveys s ON s.project_id = p.id
       LEFT JOIN quotes  q ON q.project_id = p.id
       LEFT JOIN orders  o ON o.project_id = p.id
       WHERE p.id = $1
       GROUP BY p.id`,
      [id],
    );
    if (!rows.length) return sendJson(res, 404, { error: 'Project not found' });
    return sendJson(res, 200, { data: rows[0] });
  }

  const params = [];
  let where = '';
  if (status) {
    if (!VALID_STATUSES.has(status)) {
      return sendJson(res, 400, { error: `Invalid status. Valid values: ${[...VALID_STATUSES].join(', ')}` });
    }
    params.push(status);
    where = 'WHERE p.status = $1';
  }

  const { rows } = await query(
    `SELECT p.*, COUNT(s.id) AS survey_count, COUNT(q.id) AS quote_count
     FROM projects p
     LEFT JOIN surveys s ON s.project_id = p.id
     LEFT JOIN quotes  q ON q.project_id = p.id
     ${where}
     GROUP BY p.id
     ORDER BY p.created_at DESC`,
    params,
  );

  return sendJson(res, 200, { data: rows });
}

// ── POST /api/projects ────────────────────────────────────────────────
async function createProject(req, res) {
  const { name, customer, outlet_code, outlet_name, address, region, created_by } = req.body || {};

  if (!name || !customer) {
    return sendJson(res, 400, { error: '"name" và "customer" là bắt buộc' });
  }

  const { rows } = await query(
    `INSERT INTO projects (name, customer, outlet_code, outlet_name, address, region, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [name, customer, outlet_code || null, outlet_name || null, address || null, region || null, created_by || null],
  );

  return sendJson(res, 201, { data: rows[0], message: 'Project created successfully' });
}

// ── PATCH /api/projects ───────────────────────────────────────────────
// Body: { id, status?, design_image_url? }
async function updateProject(req, res) {
  const { id, status, design_image_url } = req.body || {};

  if (!id) return sendJson(res, 400, { error: '"id" là bắt buộc' });

  // Xây dựng dynamic SET clause
  const setClauses = [];
  const params = [];

  if (status !== undefined) {
    if (!VALID_STATUSES.has(status)) {
      return sendJson(res, 400, { error: `Invalid status. Valid values: ${[...VALID_STATUSES].join(', ')}` });
    }
    params.push(status);
    setClauses.push(`status = $${params.length}`);
  }

  if (design_image_url !== undefined) {
    params.push(design_image_url);
    setClauses.push(`design_image_url = $${params.length}`);
  }

  if (setClauses.length === 0) {
    return sendJson(res, 400, { error: 'Không có trường nào được cập nhật' });
  }

  params.push(id);
  const { rows } = await query(
    `UPDATE projects SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params,
  );

  if (!rows.length) return sendJson(res, 404, { error: 'Project not found' });
  return sendJson(res, 200, { data: rows[0], message: 'Project updated successfully' });
}
