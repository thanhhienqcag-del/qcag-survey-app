# CHANGELOG — 2026-03-10

Tóm tắt các thay đổi thực hiện trong ngày 2026-03-10.

## Tính năng / Giao diện

- Thêm nút hành động "Yêu cầu chỉnh sửa" trên màn hình chi tiết (di động):
  - Chuyển từ floating bubble sang thanh cố định ở dưới cùng (`.edit-request-fab`).
  - Kiểu giao diện: pill/button, có gradient nhẹ, viền mờ, thích ứng dark/light.
  - File liên quan: `index.html`, `css/base.css`.

- Thêm bottom-sheet (overlay) để gửi "Yêu cầu chỉnh sửa":
  - Bước 1: chọn các loại chỉnh sửa (Sửa nội dung / Thay đổi hạng mục / Đổi brand) (có thể chọn nhiều).
  - Bước 2: nhập mô tả chi tiết và gửi → sẽ tạo một bình luận kiểu `edit-request` trên yêu cầu.
  - Overlay hiển thị ở trên cùng (full overlay, blur nền), hỗ trợ safe-area và responsive.
  - File liên quan: `index.html`, `css/base.css`, `js/flows/detail-flow.js`.

## Logic / JS

- Thêm logic xử lý flow chỉnh sửa trong `js/flows/detail-flow.js`:
  - `openEditRequestSheet()`, `closeEditRequestSheet()`, `toggleEditCategory()`, `proceedEditRequest()`, `submitEditRequest()`
  - Khi gửi sẽ thêm một comment vào `request.comments` với trường `commentType: 'edit-request'` và `editCategories`.
  - Khi mở màn hình chi tiết, nút edit hiện ra; khi về danh sách nó ẩn đi và đóng sheet nếu mở.

## Hiển thị bình luận

- Thay đổi cách render comment system và comment kiểu `edit-request` trong `js/flows/detail-flow.js`:
  - System messages hiển thị căn giữa, không có khung (plain text overlay).
  - Edit-request comments có style riêng (màu nền vàng nhạt / nhãn `Yêu cầu chỉnh sửa`).
  - File liên quan: `js/flows/detail-flow.js`, `css/base.css`.

## CSS / UI chỉnh sửa nhỏ

- Cập nhật style cho lựa chọn category (checkbox) dùng accent light-blue:
  - `edit-cat-check.checked` và `edit-cat-option:has(...)` dùng màu xanh nhạt phù hợp cả chế độ sáng và tối.
  - File: `css/base.css`.

- Chỉnh overlay và toast:
  - Sheet overlay đặt z-index rất cao để overlay toàn bộ UI; khi mở sẽ cho phép pointer.
  - Toast (`#toast`) nâng z-index để luôn hiển thị trên overlay.
  - File: `css/base.css`.

## Kiểm tra nhanh (đề xuất)

1. Mở một yêu cầu trên thiết bị di động (hoặc trình giả lập).
2. Kiểm tra thanh "Yêu cầu chỉnh sửa" ở dưới cùng (liền sát bottom, không hở chân).
3. Bấm vào → kiểm tra overlay (phải che toàn bộ UI, blur nền) và chọn 1–3 loại chỉnh sửa.
4. Nhập mô tả và gửi → kiểm tra comment mới xuất hiện trong danh sách bình luận với nhãn "Yêu cầu chỉnh sửa".
5. Khi sheet mở, gây ra một toast thử để đảm bảo toast hiển thị trên overlay.

---

Nếu bạn muốn, tôi có thể:
- Tinh chỉnh màu/độ bóng cho khớp đúng mockup.
- Ẩn `mobile-main-nav` khi sheet mở để tránh chồng bóng.
- Thêm icon trái (circle) vào nút để khớp UI mẫu.

