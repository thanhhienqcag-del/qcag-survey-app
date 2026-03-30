# App 2 — KS Mobile Khảo Sát

**ℹ️ TRẠNG THÁI: GIAI ĐOẠN TEST / TỐI ƯU**: Thư mục `F:\10. Code\QCAG-Production\App-2-KS-Khao-Sat` đang phục vụ cho giai đoạn thử nghiệm và phát triển. Khi tối ưu, ưu tiên thiết kế cách lưu trữ sao cho tải nhanh và tiết kiệm tài nguyên: chỉ lưu các trường cần thiết cho danh sách (minimal fields), dùng phân trang/lazy-load cho ảnh, áp dụng cache (E-Tag / in-memory) và giảm kích thước payload. Thay đổi cấu trúc dữ liệu cần được đánh giá theo hiệu năng load trước khi áp dụng rộng.

> Ứng dụng quản lý yêu cầu bảng hiệu, khảo sát thực địa (Khảo Sát Mobile).

---

## Source code cần copy vào đây

| Thành phần | Copy từ |
|---|---|
| `frontend/` | `F:\10. Code\QCAG APP\QCAG Khảo Sát\KS Mobile 1.4.3\` |
| `backend/` | `F:\10. Code\QCAG APP\backend-qcag-app\` |

> ⚠️ Chưa copy. Chờ xác nhận để thực hiện di chuyển + zip backup folder cũ.

---

## Sau khi copy xong, cấu trúc folder

```
App-2-KS-Khao-Sat/
├── README.md               ← file này
├── frontend/               ← KS Mobile 1.4.3 (Vercel project: qcag-survey-app)
│   ├── index.html
│   ├── app/
│   │   ├── js/
│   │   ├── css/
│   │   ├── api/
│   │   └── _sdk/
│   ├── vercel.json
│   └── package.json
└── backend/                ← Vercel Serverless (Neon PostgreSQL)
    ├── api/
    │   ├── surveys.js
    │   ├── quotes.js
    │   ├── orders.js
    │   ├── projects.js
    │   └── push.js
    ├── db.js
    ├── package.json
    ├── vercel.json
    └── .env.example
```

---

## Deploy

### Frontend → Vercel (`qcag-survey-app`)
```powershell
cd frontend
vercel --prod
```

### Backend phụ → Vercel (`qcag-backend`)
```powershell
cd backend
vercel --prod
```

---

## Biến môi trường backend (Vercel)

Xem bảng chi tiết trong `../CONNECTION_GUIDE.md`.

Tóm tắt: `DATABASE_URL` (Neon), `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `ALLOWED_ORIGINS`.

Config trong: Vercel Dashboard → Project `qcag-backend` → Settings → Environment Variables.

---

## Lưu ý

- Frontend gọi **Cloud Run** (`https://qcag-backend-k7disoxmcq-as.a.run.app`) cho data chính.
- Backend phụ Vercel Serverless xử lý push notifications, projects, và surveys bổ sung.
- Neon PostgreSQL là DB chính của backend Vercel (đã migrate từ MySQL 2026-03-23).
