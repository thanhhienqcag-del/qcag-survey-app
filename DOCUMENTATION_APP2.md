# DOCUMENTATION APP 2 — QCAG KHẢO SÁT

---

## 1. Vai Trò & Tổng Quan Hệ Thống

Ứng dụng **App 2 (QCAG Khảo Sát)** phục vụ cho nhân viên khảo sát thị trường và sale để:
- Tạo yêu cầu khảo sát hiện trạng điểm bán/công trình trên di động hoặc web client.
- Thu thập hình ảnh khảo sát, tọa độ GPS, thông tin đơn vị hành chính (DVHC).
- Đồng bộ dữ liệu khảo sát sang **App 1 (QCAG Báo Giá)** thông qua PostgreSQL `ks_quote_bridge`.
- Quản lý tiến độ hoàn thành tác vụ khảo sát và duyệt ảnh thiết kế.

---

## 2. Danh Sách API Endpoints Trọng Yếu (`backend/index.js`)

| Phương thức | Endpoint | Mô tả chức năng |
| :--- | :--- | :--- |
| `GET` | `/api/ks/health` | Kiểm tra trạng thái API server Khảo sát |
| `GET` | `/api/ks/requests` | Lấy danh sách yêu cầu khảo sát (bật/tắt filter, phân trang) |
| `POST` | `/api/ks/requests` | Tạo mới yêu cầu khảo sát hiện trạng |
| `GET` | `/api/ks/requests/:id` | Xem chi tiết 1 bản ghi khảo sát |
| `PATCH` | `/api/ks/requests/:id` | Cập nhật yêu cầu khảo sát / upload ảnh hiện trạng |
| `DELETE` | `/api/ks/requests/:id` | Xóa bản ghi khảo sát |
| `POST` | `/api/ks/requests/:id/approve-production` | Heineken / Sale duyệt mẫu thiết kế |
| `POST` | `/api/ks/requests/:id/reject-production` | Từ chối mẫu thiết kế |
| `POST` | `/api/ks/requests/:id/request-edit-production` | Yêu cầu sửa đổi mẫu thiết kế |
| `POST` | `/api/ks/upload` | Upload hình ảnh khảo sát lên GCS |
| `GET` | `/api/ks/settings/:key` | Đọc cấu hình app settings |

---

## 3. Kiến Trúc Mã Nguồn App 2

- `backend/`:
  - `index.js`: Express API Server Khảo Sát & duyệt thiết kế.
  - `db.js`: Quản lý pool kết nối PostgreSQL chính cho App 2.
  - `storage.js`: Upload và đọc tệp phương tiện khảo sát trên GCS.
  - `sql/`: Scripts khởi tạo schema (`ks_mobile_init.sql`, `schema.sql`).
  - `scripts/diagnostics/`: Scripts chẩn đoán kết nối (`check_latest.js`, `check_schema.js`, `diagnose.js`).
- `frontend/`:
  - `index.html`: Web UI Khảo sát.
  - `app/`: Mobile PWA App dành cho NV khảo sát tại công trình.
  - `sw.js`: Service Worker hỗ trợ làm việc offline.

---

## 4. Triển Khai & Hướng Dẫn Vận Hành

- **Backend**: Cloud Run (`deploy-app2.ps1` ở root).
- **Frontend**: Vercel Serverless (`vercel.json`).
- **Biến môi trường**: `DATABASE_URL`, `AUTH_SECRET`, `PORT`.
