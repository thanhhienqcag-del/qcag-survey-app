// API endpoint trả về cấu hình runtime cho client.
// Đã loại bỏ Supabase. Chỉ export BACKEND_URL để data_sdk.js
// biết địa chỉ QCAG backend (Cloud Run).

module.exports = (req, res) => {
  const env = {
    // URL của QCAG backend Cloud Run (ví dụ: https://qcag-backend-xxx.run.app)
    // Để trống = same-origin (khi frontend serve từ cùng backend)
    BACKEND_URL: process.env.BACKEND_URL || ''
  };
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 200;
  res.end(`window.__env = ${JSON.stringify(env)};`);
};
