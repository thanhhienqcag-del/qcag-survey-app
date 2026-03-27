# Changelog — 2026-03-08

- **Tổng quan**: Một loạt chỉnh sửa UI/UX và logic để hoàn thiện hành vi cảnh báo trùng outlet, modal, và đảm bảo trạng thái form trở về mặc định sau khi tạo yêu cầu.

## Thay đổi chính

- UI: `survey-warning`
  - Khôi phục nền và màu chữ; đổi viền sang bao quanh toàn bộ khối (full-box).
  - Ở chế độ sáng đổi sang tông đỏ (viền đỏ / nền nhạt / chữ đỏ đậm).
  - File: `index.html` (CSS block cập nhật).

- Modal cảnh báo trùng `duplicateOutletModal`
  - Nội dung và hành vi:
    - Nếu có **1** yêu cầu trùng trong năm hiện tại → hiển thị thời gian cụ thể (xuống dòng sau "vào lúc") và nút **"Xem lại Yêu Cầu"** mở chi tiết.
    - Nếu có **>= 2** yêu cầu trong năm hiện tại → hiển thị "Bạn có N yêu cầu trong năm YYYY" và nút **"Xem danh sách"** (mở danh sách và tự lọc theo mã outlet).
    - Nếu chỉ có yêu cầu ở năm cũ → **không hiện modal**, thay vào đó tự động điền (autofill) Tab 1 từ yêu cầu gần nhất.
  - Thêm câu hỏi xác nhận: "Bạn có chắc đây là hạng mục mới của Outlet này không?"
  - Thêm nút đóng `X`; khi đóng sẽ xóa toàn bộ dữ liệu Tab 1.
  - File: `index.html`, `js/flows/request-flow.js`.

- Logic kiểm tra trùng (`checkOutletDuplicate`)
  - Chỉ chạy khi mã outlet là **8 chữ số** chính xác.
  - Chỉ đếm yêu cầu thuộc quyền sở hữu của phiên đăng nhập hiện tại (giống logic render danh sách).
  - Luôn cảnh báo mỗi lần nhập mã trùng (nếu mã hợp lệ).
  - Xử lý theo năm: năm hiện tại → modal; chỉ có năm cũ → autofill Tab 1.
  - File: `js/flows/request-flow.js`.

- Hành vi nút modal
  - Bấm **"Xem lại Yêu Cầu"** → modal ẩn ngay và mở chi tiết.
  - Bấm **"Xem danh sách"** → modal ẩn và chuyển sang màn hình danh sách với ô tìm kiếm đã điền mã outlet.

- Reset trạng thái form / New Outlet
  - Khi tạo yêu cầu mới hoặc gọi `resetNewRequestForm()`:
    - Đặt `New Outlet` toggle về OFF.
    - Bỏ readOnly trên ô mã, hiện lại nút Paste, ẩn icon khoá.
    - Xóa các trường Tab 1 và cập nhật preview vị trí.
    - Xoá draft bằng đúng key `OUTLET_DRAFT_KEY`.
  - Files: `js/flows/request-flow.js`, `js/core/router.js`.

- Search UI
  - Loại bỏ icon kính lúp khỏi ô tìm kiếm ở trang danh sách; điều chỉnh padding input.
  - File: `index.html`.

## Files đã chỉnh
- index.html
- js/flows/request-flow.js
- js/core/router.js

## Kiểm thử gợi ý
- Nhập mã trùng (8 chữ số) → modal xuất hiện (1 yêu cầu vs nhiều yêu cầu vs yêu cầu chỉ ở năm cũ).
- Bấm "Xem lại Yêu Cầu" → modal ẩn và mở chi tiết.
- Đóng modal bằng `X` → Tab 1 bị xóa/reset.
- Tạo yêu cầu mới → New Outlet toggle mặc định OFF.
- "Xem danh sách" lọc đúng theo mã outlet.

---

Nếu muốn, tôi có thể commit file này vào git hoặc hợp nhất vào `CHANGELOG-EDIT.md` có sẵn. Hướng dẫn bạn muốn tôi làm tiếp gì?