# App 2 — QCAG Khảo Sát

Ứng dụng phục vụ công tác khảo sát công trình hiện trường, quản lý hình ảnh, tọa độ và đồng bộ tác vụ thiết kế sang App 1.

## 1. Tài liệu chi tiết
Toàn bộ thông tin về kiến trúc, luồng hoạt động, cấu hình PWA di động và hướng dẫn xử lý lỗi đã được gom gọn tại:
- 👉 [DOCUMENTATION_APP2.md](file:///f:/10.%20Code/QCAG-Production%20Main/QCAG-Production/App-2-KS-Khao-Sat/DOCUMENTATION_APP2.md)

## 2. Cấu Trúc Thư Mục Tinh Gọn

```text
App-2-KS-Khao-Sat/
├── README.md
├── DOCUMENTATION_APP2.md        # Tài liệu duy nhất của App 2
├── backend/
│   ├── index.js                 # API server chính của Khảo Sát
│   ├── db.js                    # Kết nối Postgres DB
│   ├── storage.js               # Lưu trữ tệp phương tiện
│   ├── sql/                     # Chứa các script SQL khởi tạo schema
│   └── scripts/diagnostics/     # Chứa các script chẩn đoán DB
└── frontend/
    ├── index.html               # Web UI Khảo sát
    ├── app/                     # Mobile PWA App
    └── sw.js                    # Service Worker Offline
```

## 3. Triển Khai Dịch Vụ
- **Backend**: Chạy `../deploy-app2.ps1` từ root.
- **Frontend**: Triển khai qua Vercel (`vercel.json`).
