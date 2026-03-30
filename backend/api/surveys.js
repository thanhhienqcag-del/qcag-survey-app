// api/surveys.js — Vercel Serverless Function
// Routes: GET /api/surveys, POST /api/surveys, PATCH /api/surveys
'use strict';

const { query, withTransaction } = require('../db');
const { uploadImage } = require('../lib/upload');

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
      case 'GET':   return await getSurveys(req, res);
      case 'POST':  return await createSurvey(req, res);
      case 'PATCH': return await updateSurvey(req, res);
      default:
        return sendJson(res, 405, { error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('[surveys] Unhandled error:', err);
    return sendJson(res, 500, { error: 'Internal server error' });
  }
};

// ── GET /api/surveys?project_id=123 ──────────────────────────────────
async function getSurveys(req, res) {
  const { project_id, id } = req.query;

  if (id) {
    const { rows } = await query('SELECT * FROM surveys WHERE id = $1', [id]);
    if (!rows.length) return sendJson(res, 404, { error: 'Survey not found' });
    return sendJson(res, 200, { data: rows[0] });
  }

  if (!project_id) return sendJson(res, 400, { error: '"project_id" là bắt buộc' });

  const { rows } = await query(
    'SELECT * FROM surveys WHERE project_id = $1 ORDER BY created_at DESC',
    [project_id],
  );
  return sendJson(res, 200, { data: rows });
}

// ── POST /api/surveys ─────────────────────────────────────────────────
// Body: { project_id, survey_data, images: ['data:image/...'], surveyed_by?, notes? }
// images có thể là mảng data URI base64 → sẽ upload lên Cloudinary
async function createSurvey(req, res) {
  const { project_id, survey_data, images = [], surveyed_by, notes } = req.body || {};

  if (!project_id) return sendJson(res, 400, { error: '"project_id" là bắt buộc' });

  // Kiểm tra project tồn tại
  const { rows: projectRows } = await query('SELECT id FROM projects WHERE id = $1', [project_id]);
  if (!projectRows.length) return sendJson(res, 404, { error: 'Project not found' });

  // Upload từng ảnh lên Cloudinary song song
  let uploadedUrls = [];
  if (Array.isArray(images) && images.length > 0) {
    const results = await Promise.allSettled(
      images.map((img, i) =>
        uploadImage(img, { folder: `qcag/surveys/${project_id}`, publicId: `survey_${Date.now()}_${i}` })
      ),
    );
    uploadedUrls = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value.url);

    const failCount = results.filter(r => r.status === 'rejected').length;
    if (failCount > 0) console.warn(`[surveys] ${failCount} image(s) failed to upload`);
  }

  // Lưu survey và cập nhật project status trong cùng 1 transaction
  const { rows } = await withTransaction(async (client) => {
    const res = await client.query(
      `INSERT INTO surveys (project_id, survey_data, images, surveyed_by, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [project_id, JSON.stringify(survey_data || {}), JSON.stringify(uploadedUrls), surveyed_by || null, notes || null],
    );

    // Sau khi có survey → project sẵn sàng báo giá
    await client.query(
      `UPDATE projects SET status = 'ready_for_quote' WHERE id = $1 AND status = 'pending'`,
      [project_id],
    );

    return res.rows;
  });

  return sendJson(res, 201, {
    data: rows[0],
    uploadedImages: uploadedUrls.length,
    message: 'Survey created successfully',
  });
}

// ── PATCH /api/surveys ────────────────────────────────────────────────
// Body: { id, status?, notes?, survey_data? }
async function updateSurvey(req, res) {
  const { id, status, notes, survey_data } = req.body || {};
  if (!id) return sendJson(res, 400, { error: '"id" là bắt buộc' });

  const setClauses = [];
  const params = [];

  if (status !== undefined) { params.push(status); setClauses.push(`status = $${params.length}`); }
  if (notes !== undefined)  { params.push(notes);  setClauses.push(`notes = $${params.length}`); }
  if (survey_data !== undefined) {
    params.push(JSON.stringify(survey_data));
    setClauses.push(`survey_data = $${params.length}`);
  }

  if (!setClauses.length) return sendJson(res, 400, { error: 'Không có trường nào được cập nhật' });

  params.push(id);
  const { rows } = await query(
    `UPDATE surveys SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params,
  );

  if (!rows.length) return sendJson(res, 404, { error: 'Survey not found' });
  return sendJson(res, 200, { data: rows[0], message: 'Survey updated successfully' });
}
