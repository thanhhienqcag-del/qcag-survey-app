# Ghi chú chỉnh sửa — 22/03/2026

Tóm tắt các chỉnh sửa thực hiện trong ngày:

- Toast (thông báo): thu gọn, canh giữa màn hình, dạng pill, bo tròn hai đầu, có viền màu cam; hiệu ứng thả từ trên xuống; min-width = 25vw, max-width ≈ 30rem; chữ canh giữa; tự ẩn sau ~2.5s.
- Giao diện chế độ sáng: giảm độ sáng tổng thể (chuyển nhiều `bg-white` → `bg-gray-100`), giảm bóng đổ (shadow giảm cỡ), giữ tương phản chữ.
- Nút lọc khu vực: sửa để hiển thị tốt ở chế độ sáng; trạng thái được chọn có viền dày hơn, nền đậm hơn và hiệu ứng nâng nhẹ (shadow + translate) — áp dụng cho cả chế độ sáng và tối.
- Một số điều chỉnh nhỏ khác: khoảng cách nút copy outlet, các ô input/textarea và modal được làm dịu màu nền.

Các file đã chỉnh sửa:

- `index.html` — thay đổi markup của toast; cập nhật nhiều `bg-white` → `bg-gray-100`; điều chỉnh input/button/modal; tinh chỉnh copy button spacing.
- `app/js/shared/ui.js` — cập nhật `showToast()` để điều khiển animation drop-in của `#toastInner` và tự ẩn.
- `app/css/desktop.css` — thêm override cho `[data-theme="light"] .qcag-detail-filter-btn` và tăng mức nhấn (`.active`) cho cả theme light/dark.
- `backend-qcag-app/index.js` — thay đổi source backend để thêm/điều chỉnh trường metadata (ví dụ: `designCreatedBy/At`, `designLastEditedBy/At`) nhưng CHƯA được deploy.

Ghi chú quan trọng:

- Thay đổi backend chưa được áp dụng lên production vì deploy tới Cloud Run thất bại do vấn đề xác thực GCP (invalid_grant / tài khoản `qcag.app@gmail.com` bị khoá do nhiều lần thử không thành công). Vì vậy các ALTER/UPDATE schema chưa chạy trên DB production và metadata vẫn chưa được lưu trữ bền vững.

Hành động tiếp theo đề xuất:

1. Mở khoá / phục hồi tài khoản GCP và re-deploy backend; hoặc
2. Cấp key service-account để deploy thay thế; hoặc
3. Giao file SQL ALTER (tôi có thể tạo) để admin DB chạy trực tiếp trên Cloud SQL.

Nếu bạn muốn, tôi sẽ:

- Chuẩn bị file SQL ALTER cần chạy trên production ngay lập tức; hoặc
- Thực hiện re-deploy nếu bạn cung cấp quyền/credential phù hợp.

Người thực hiện: GitHub Copilot (thực hiện chỉnh sửa frontend & chuẩn bị backend changes)

-----
Tệp này được tạo tự động để ghi lại những thay đổi của ngày 22/03/2026.
