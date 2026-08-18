'use strict';

/**
 * lib/v3-helpers.js — Target Schema v4 Data Layer Helpers for App 2
 */

/**
 * Dynamically format full address string from granular outlet address component columns.
 */
function formatOutletAddress(outlet) {
  if (!outlet) return '';
  const parts = [
    outlet.house_number,
    outlet.street,
    outlet.ward,
    outlet.district,
    outlet.province
  ].map(p => (p && String(p).trim() !== '\\N') ? String(p).trim() : null).filter(Boolean);

  return parts.length > 0 ? parts.join(', ') : (outlet.region || '');
}

/**
 * Find or create an outlet by code/name with granular address components, returning UUID id.
 */
async function findOrCreateOutlet(pool, { code, name, house_number, street, ward, district, province, region, phone, lat, lng }) {
  const cleanCode = String(code || '').trim() || ('OUT_' + Date.now());
  const cleanName = String(name || cleanCode).trim();
  
  const resFind = await pool.query(
    'SELECT id, house_number, street, ward, district, province FROM outlets WHERE code = $1 OR (is_deleted = false AND name = $2) LIMIT 1',
    [cleanCode, cleanName]
  );
  if (resFind.rows && resFind.rows.length > 0) {
    return resFind.rows[0].id;
  }

  const resIns = await pool.query(
    `INSERT INTO outlets (code, name, phone, house_number, street, ward, district, province, region, lat, lng)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      cleanCode,
      cleanName,
      phone || null,
      house_number || null,
      street || null,
      ward || null,
      district || null,
      province || region || null,
      region || null,
      lat ? Number(lat) : null,
      lng ? Number(lng) : null
    ]
  );
  return resIns.rows[0].id;
}

/**
 * Find or create a user account by username/fullname/role, returning UUID.
 */
async function findOrCreateUser(pool, { username, fullname, role, phone }) {
  const cleanUsername = String(username || '').trim().toLowerCase() || ('user_' + Date.now());
  const cleanFullname = String(fullname || cleanUsername).trim();
  const cleanRole = String(role || 'ks_staff').trim();

  const resFind = await pool.query('SELECT id FROM users WHERE username = $1 LIMIT 1', [cleanUsername]);
  if (resFind.rows && resFind.rows.length > 0) {
    return resFind.rows[0].id;
  }

  const resIns = await pool.query(
    `INSERT INTO users (username, password_hash, fullname, role, phone, approved, is_active)
     VALUES ($1, $2, $3, $4, $5, true, true)
     RETURNING id`,
    [cleanUsername, '$2b$10$hashed_default', cleanFullname, cleanRole, phone || null]
  );
  return resIns.rows[0].id;
}

/**
 * Get next survey request code using PostgreSQL Native Sequence (Format: TKYY.NNNNN, e.g. TK26.00001).
 */
async function getNextTkCode(pool) {
  const currentYear = new Date().getFullYear().toString().slice(-2);
  const seqName = `seq_request_${currentYear}`;

  await pool.query(`CREATE SEQUENCE IF NOT EXISTS ${seqName} START WITH 1`);
  const res = await pool.query(`SELECT nextval('${seqName}') AS val`);
  const num = Number(res.rows[0].val);
  return `TK${currentYear}.${String(num).padStart(5, '0')}`;
}

/**
 * Save images to assets table for an owner.
 */
async function saveAssets(pool, ownerType, ownerCode, imageUrls, category = 'general', createdBy = null) {
  if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length === 0) return;

  for (let i = 0; i < imageUrls.length; i++) {
    const url = String(imageUrls[i] || '').trim();
    if (url) {
      await pool.query(
        `INSERT INTO assets (owner_type, owner_code, category, url, sort_order, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [ownerType, ownerCode, category, url, i, createdBy]
      );
    }
  }
}

/**
 * Fetch asset URLs for an owner.
 */
async function getAssets(pool, ownerType, ownerCode, category = null) {
  let query = 'SELECT url FROM assets WHERE owner_type = $1 AND owner_code = $2';
  const params = [ownerType, ownerCode];

  if (category) {
    query += ' AND category = $3';
    params.push(category);
  }
  query += ' ORDER BY sort_order ASC, created_at ASC';

  const res = await pool.query(query, params);
  return res.rows.map(r => r.url);
}

/**
 * Convert Target Schema v6 survey request record to App 2 Frontend JSON format.
 * 
 * Expected SQL query pattern:
 *   SELECT r.*,
 *     o.code AS outlet_code, o.name AS outlet_name, o.phone AS outlet_phone,
 *     o.house_number, o.street, o.ward, o.district, o.province, o.region AS outlet_region,
 *     o.lat AS outlet_lat, o.lng AS outlet_lng,
 *     req.fullname AS requester_fullname, req.phone AS requester_phone,
 *     dc.fullname AS designer_fullname
 *   FROM requests r
 *   LEFT JOIN outlets o ON r.outlet_id = o.id
 *   LEFT JOIN users req ON r.requester_id = req.id
 *   LEFT JOIN users dc ON r.design_created_by = dc.id
 */
function requestRowToApp(row, items = [], statusImages = [], designImages = [], acceptanceImages = []) {
  if (!row) return null;

  const fullAddress = formatOutletAddress({
    house_number: row.house_number,
    street: row.street,
    ward: row.ward,
    district: row.district,
    province: row.province || row.outlet_region
  });

  return {
    __backendId: row.tk_code,
    id: row.tk_code,
    tkCode: row.tk_code,
    type: row.type || 'new',
    // From outlets JOIN
    outletCode: row.outlet_code || '',
    outletName: row.outlet_name || '',
    address: fullAddress,
    houseNumber: row.house_number || '',
    street: row.street || '',
    ward: row.ward || '',
    district: row.district || '',
    province: row.province || row.outlet_region || '',
    outletLat: row.outlet_lat ? String(row.outlet_lat) : '',
    outletLng: row.outlet_lng ? String(row.outlet_lng) : '',
    // From users JOIN (requester)
    phone: row.requester_phone || row.outlet_phone || '',
    items: items,
    content: row.survey_content || '',
    oldContent: Boolean(row.old_content),
    status: row.status || 'pending',
    requester: row.requester_fullname || '',
    comments: [],
    statusImages: statusImages,
    designImages: designImages,
    acceptanceImages: acceptanceImages,
    editingRequestedAt: row.editing_requested_at || null,
    mqFolder: row.mq_folder || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // From users JOIN (designer)
    designCreatedBy: row.designer_fullname || row.design_created_by || '',
    designCreatedAt: row.design_created_at || null,
    designStatus: row.design_status || 'pending',
    designLastEditedBy: '',
    designLastEditedAt: null
  };
}

module.exports = {
  formatOutletAddress,
  findOrCreateOutlet,
  findOrCreateUser,
  getNextTkCode,
  saveAssets,
  getAssets,
  requestRowToApp
};
