/**
 * migrate-supabase-to-mysql.js
 * ============================================================
 * Xuất toàn bộ dữ liệu từ Supabase (PostgreSQL + Storage)
 * và import vào Cloud SQL MySQL thông qua backend API mới.
 *
 * Cách dùng:
 *   1. Điền các biến môi trường bên dưới (hoặc set env vars)
 *   2. node migrate-supabase-to-mysql.js
 *
 * Yêu cầu:
 *   - Node.js >= 18 (fetch built-in)
 *   - npm i node-fetch@2  (nếu Node < 18)
 *   - Backend mới phải đang chạy (local hoặc Cloud Run)
 * ============================================================
 */

// ── CẤU HÌNH ──────────────────────────────────────────────────────────
const SUPABASE_URL    = process.env.SUPABASE_URL    || 'https://kuflixiicocxhdwzfxct.supabase.co';
const SUPABASE_KEY    = process.env.SUPABASE_ANON_KEY || 'sb_publishable_HnObLflcqXh_8qjAFVjAaA_PV_eGJY7';
// URL backend mới (Cloud Run hoặc http://localhost:3000 khi test local)
const BACKEND_URL     = process.env.KS_BACKEND_URL  || 'http://localhost:3000';
// Bucket GCS cho KS Mobile (để migrate ảnh Supabase → GCS)
// Để trống nếu chỉ muốn migrate metadata, ảnh giữ URL Supabase cũ.
const MIGRATE_IMAGES  = (process.env.MIGRATE_IMAGES || 'false') === 'true';
const DRY_RUN         = (process.env.DRY_RUN        || 'false') === 'true';
// ── END CẤU HÌNH ───────────────────────────────────────────────────────

// Polyfill fetch cho Node 16 trở xuống
let _fetch;
try { _fetch = fetch; } catch (e) {
  try { _fetch = require('node-fetch'); } catch (e2) {
    console.error('Cần Node >= 18 hoặc cài node-fetch: npm i node-fetch@2');
    process.exit(1);
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── 1. Lấy toàn bộ requests từ Supabase ──────────────────────────────
async function fetchSupabaseRequests() {
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };

  let allRows = [];
  let offset = 0;
  const PAGE = 1000;

  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/requests?select=*&order=created_at.asc&offset=${offset}&limit=${PAGE}`;
    console.log(`  Fetching Supabase rows ${offset}–${offset + PAGE - 1}...`);
    const resp = await _fetch(url, { headers });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Supabase fetch failed ${resp.status}: ${txt}`);
    }
    const rows = await resp.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    allRows = allRows.concat(rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }

  console.log(`  Supabase: ${allRows.length} rows tổng cộng`);
  return allRows;
}

// ── 2. Convert Supabase row → app format (mirror supabase.js _fromDbRow) ──
function fromDbRow(row) {
  if (!row) return null;
  const meta = (row.metadata && typeof row.metadata === 'object') ? row.metadata : {};
  return Object.assign({}, meta, {
    id:          row.id,
    __backendId: meta.__backendId || ('srv_' + row.id),
    outletCode:  row.outlet_code || meta.outletCode  || '',
    outletName:  row.outlet_name || meta.outletName  || '',
    phone:       row.phone       || meta.phone       || '',
    address:     row.address     || meta.address     || '',
    status:      row.status      || meta.status      || 'pending',
    createdAt:   row.created_at  || meta.createdAt   || '',
  });
}

// ── 3. Download ảnh từ Supabase Storage → upload lên backend GCS ──────
async function migrateImageUrl(url) {
  if (!url || !url.includes('supabase')) return url; // không phải ảnh Supabase
  try {
    const imgResp = await _fetch(url);
    if (!imgResp.ok) {
      console.warn(`    Không download được ảnh: ${url}`);
      return url; // giữ URL cũ nếu lỗi
    }
    const arrayBuf = await imgResp.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    const ct = imgResp.headers.get('content-type') || 'image/jpeg';
    const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
    const dataUrl = `data:${ct};base64,${buf.toString('base64')}`;

    const uploadResp = await _fetch(`${BACKEND_URL}/api/ks/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl, filename: `migrated.${ext}` })
    });
    const result = await uploadResp.json();
    if (result.ok && result.url) {
      return result.url;
    }
    console.warn(`    Upload thất bại cho: ${url}`, result);
    return url;
  } catch (e) {
    console.warn(`    Lỗi migrate ảnh: ${url}`, e.message);
    return url;
  }
}

async function migrateImageArray(jsonStr) {
  if (!jsonStr) return '[]';
  let arr;
  try { arr = JSON.parse(jsonStr); } catch (e) { return '[]'; }
  if (!Array.isArray(arr) || arr.length === 0) return '[]';
  const migrated = await Promise.all(arr.map(migrateImageUrl));
  return JSON.stringify(migrated);
}

// ── 4. Import 1 record vào backend MySQL ──────────────────────────────
async function importRecord(record) {
  // Migrate images nếu được yêu cầu
  if (MIGRATE_IMAGES) {
    record.statusImages       = await migrateImageArray(record.statusImages);
    record.designImages       = await migrateImageArray(record.designImages);
    record.acceptanceImages   = await migrateImageArray(record.acceptanceImages);
    record.oldContentImages   = await migrateImageArray(record.oldContentImages);
  }

  const resp = await _fetch(`${BACKEND_URL}/api/ks/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record)
  });
  const result = await resp.json();
  if (!result.ok) throw new Error(`Backend create failed: ${JSON.stringify(result)}`);
  return result.data;
}

// ── 5. Kiểm tra backend_id đã tồn tại trong MySQL chưa ──────────────
async function backendIdExists(backendId) {
  try {
    const resp = await _fetch(`${BACKEND_URL}/api/ks/requests/${encodeURIComponent(backendId)}`);
    if (resp.status === 404) return false;
    const result = await resp.json();
    return result.ok === true;
  } catch (e) { return false; }
}

// ── MAIN ───────────────────────────────────────────────────────────────
async function main() {
  console.log('=' .repeat(60));
  console.log('KS Mobile: Migrate Supabase → MySQL');
  console.log(`Backend   : ${BACKEND_URL}`);
  console.log(`Supabase  : ${SUPABASE_URL}`);
  console.log(`Images    : ${MIGRATE_IMAGES ? 'MIGRATE (re-upload to GCS)' : 'GIỮ URL CŨ'}`);
  console.log(`Dry run   : ${DRY_RUN}`);
  console.log('=' .repeat(60));

  // Kiểm tra backend healthy
  try {
    const h = await _fetch(`${BACKEND_URL}/api/ks/health`);
    const hj = await h.json();
    if (!hj.ok) throw new Error('backend not ok');
    console.log('✓ Backend healthy');
  } catch (e) {
    console.error(`✗ Không kết nối được backend: ${BACKEND_URL}`);
    console.error('  Hãy đảm bảo backend đang chạy trước khi migrate.');
    process.exit(1);
  }

  // Lấy dữ liệu Supabase
  console.log('\n[1/3] Lấy dữ liệu từ Supabase...');
  const rows = await fetchSupabaseRequests();

  if (rows.length === 0) {
    console.log('Không có dữ liệu Supabase để migrate. Kết thúc.');
    return;
  }

  // Import từng record
  console.log(`\n[2/3] Import ${rows.length} records vào MySQL...`);
  let ok = 0, skipped = 0, failed = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const record = fromDbRow(row);
    const backendId = record.__backendId;

    process.stdout.write(`  [${i + 1}/${rows.length}] ${backendId}... `);

    // Idempotency: bỏ qua nếu đã tồn tại
    const exists = await backendIdExists(backendId);
    if (exists) {
      process.stdout.write('SKIP (đã tồn tại)\n');
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      process.stdout.write('DRY-RUN OK\n');
      ok++;
      continue;
    }

    try {
      await importRecord(record);
      process.stdout.write('OK\n');
      ok++;
    } catch (e) {
      process.stdout.write(`FAIL: ${e.message}\n`);
      errors.push({ backendId, error: e.message });
      failed++;
    }

    // Rate limit nhẹ
    if ((i + 1) % 50 === 0) await sleep(500);
  }

  console.log(`\n[3/3] Kết quả:`);
  console.log(`  ✓ Thành công : ${ok}`);
  console.log(`  ⤵ Bỏ qua    : ${skipped}`);
  console.log(`  ✗ Thất bại  : ${failed}`);

  if (errors.length > 0) {
    console.log('\nChi tiết lỗi:');
    errors.forEach(e => console.log(`  - ${e.backendId}: ${e.error}`));
    process.exit(1);
  }

  console.log('\n✓ Migrate hoàn tất!');
  console.log('\nBước tiếp theo:');
  console.log('  1. Kiểm tra dữ liệu: GET ' + BACKEND_URL + '/api/ks/requests');
  console.log('  2. Xác nhận ảnh (nếu không migrate images, ảnh vẫn dùng URL Supabase)');
  console.log('  3. Sau khi xác nhận OK, xóa project Supabase.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
