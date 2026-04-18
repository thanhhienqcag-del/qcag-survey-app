'use strict';
// Xóa request test sau khi kiểm tra xong
const { Pool } = require('pg');
const DB = process.env.DATABASE_URL ||
  'postgresql://neondb_owner:npg_tC3ymrsEYQk2@ep-floral-pine-a18w14pz-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
const pool = new Pool({ connectionString: DB, ssl: { rejectUnauthorized: false } });
async function run() {
  // Xóa theo id truyền vào hoặc xóa toàn bộ request test
  const targetId = process.argv[2];
  let res;
  if (targetId) {
    res = await pool.query('DELETE FROM ks_requests WHERE id = $1 RETURNING id, outlet_name', [Number(targetId)]);
  } else {
    res = await pool.query("DELETE FROM ks_requests WHERE outlet_name LIKE '[TEST]%' RETURNING id, outlet_name");
  }
  console.log('✅ Đã xóa:', res.rows);
  await pool.end();
}
run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
