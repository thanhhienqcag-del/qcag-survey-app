**Thông tin triển khai — KS Mobile**

- **Ngày:** 2026-03-14
- **Mục đích:** Ghi lại địa chỉ Vercel và Supabase, lẫn các bước để redeploy và kiểm tra.

**Địa chỉ (URL)**
- Vercel (production): https://project-9f778.vercel.app
- Supabase project URL: https://kuflixiicocxhdwzfxct.supabase.co

Lưu ý: nếu Vercel hoặc Supabase có tên khác trên tài khoản của bạn, thay thế tương ứng.

**Biến môi trường cần cấu hình trên Vercel (Project → Settings → Environment Variables)**
- `SUPABASE_URL` = https://kuflixiicocxhdwzfxct.supabase.co
- `SUPABASE_ANON_KEY` = (Supabase anon/public key)
- `SUPABASE_SERVICE_ROLE_KEY` = (chỉ nếu bạn sử dụng server-side; không commit key này)

Không lưu `SUPABASE_SERVICE_ROLE_KEY` trong mã nguồn công khai.

**Các file đã chỉnh sửa / thêm trong repo (cần redeploy để có hiệu lực)**
- `index.html` — nạp `/api/env` và Supabase CDN, đảm bảo `_sdk/supabase.js` được load trước `_sdk/data_sdk.js`.
- `api/env.js` — serverless endpoint trả về `window.__env` chứa `SUPABASE_URL` và `SUPABASE_ANON_KEY` tại runtime.
- `_sdk/supabase.js` — wrapper Supabase client (thêm `updateRequest`).
- `_sdk/data_sdk.js` — hỗ trợ dùng `window.supabaseApi` (fetch/create/update) khi chạy trên Vercel; fallback về `/data` cho môi trường local.

**Cách redeploy nhanh (CLI)**
1. Đăng nhập Vercel (nếu chưa):
```bash
vercel login
```
2. Từ thư mục project (nơi chứa `index.html`):
```bash
vercel --prod --yes
```

**Kiểm tra sau deploy**
- Health: `GET https://<your-domain>/sync` → trả `{ ok: true, ts: ... }`.
- Data: `GET https://<your-domain>/data` để xem dữ liệu hiện tại (nếu dùng local API) hoặc kiểm tra Supabase table `requests`.
- Tạo request/upload ảnh: mở app trên điện thoại và thử thao tác 'Xác nhận yêu cầu' — kiểm tra Network/Console trên DevTools hoặc phần Logs trên Vercel Deployments nếu lỗi.

**Ghi chú debug nhanh nếu lỗi tạo yêu cầu trên production**
1. Kiểm tra Vercel → Project → Environment Variables: `SUPABASE_URL` và `SUPABASE_ANON_KEY` phải chính xác.
2. Mở Vercel → Deployments → chọn deployment → Logs: xem lỗi từ serverless `/api/env` hoặc CDN/Supabase requests.
3. Kiểm tra Network tab trong browser trên device: xem request tới `/api/env`, `/data` hoặc gọi Supabase trực tiếp (401/403 => key sai hoặc RLS policy).

Nếu muốn, tôi có thể lưu thêm `VERCEL_PROJECT` hoặc `SUPABASE_PROJECT_ID` vào file này nếu bạn cung cấp.

---

File này là tài liệu ngắn gọn để bạn mở lại mà không cần tìm thông tin.
