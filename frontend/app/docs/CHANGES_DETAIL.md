# CHANGES — Chi Tiết Yêu Cầu (Detail view)

Date: 2026-03-04

## Mục đích
Tập hợp nhanh những thay đổi đã thực hiện để bạn dễ theo dõi (CSS + JS) cho trang `Chi Tiết Yêu Cầu`.

## Tóm tắt thay đổi chính
- Chuẩn hoá và hiển thị thông tin `Người yêu cầu` (Sale / QCAG) như một khối riêng trong view chi tiết và modal thiết kế.
- Sửa lỗi khai báo trùng (duplicate `isMobile`) trong `detail-flow.js` gây vỡ view.
- Thực hiện layout 2 cột trên desktop: content trái (cuộn), comment phải (cố định, không cuộn).
- Chuẩn hoá style các card (background, border, radius, padding, spacing) và làm tối nền tổng thể để tăng tương phản.

## Các file đã sửa
- [js/flows/detail-flow.js](js/flows/detail-flow.js)
  - Thêm rendering khối `Người yêu cầu` (dùng `request.requester` hoặc fallback `currentSession`).
  - Điều chỉnh hiển thị cho mobile (stacked labels) và desktop (grid 2 cột).
  - Sửa duplicate `isMobile` để tránh lỗi runtime.
  - Cập nhật modal thiết kế (`viewDesign`) thêm label người yêu cầu.

- [css/base.css](css/base.css)
  - Thay đổi nền trang sang màu tối nhẹ (`#eef4f8`).
  - Thêm quy tắc global cho card: background trắng, border `#e5e7eb`, radius 10px, padding 16px, shadow nhẹ.
  - Thêm `.detail-card` helper.

- [css/desktop.css](css/desktop.css)
  - Thiết lập layout desktop 2 block: `.detail-two-col` (container), `.detail-main` (content trái, scrollable), `.detail-comments-col` (panel phải, `position: fixed`).
  - Panel bên phải có width `320px`, full-height (top/bottom offset 20px), comment list scroll riêng, input cố định dưới đáy panel.
  - Thêm helper classes: `.detail-layout`, `.detail-content`, `.comment-panel`, `.detail-card`.

## Cách kiểm tra nhanh
1. Chạy server và mở `http://localhost:3000` → vào màn `Chi Tiết Yêu Cầu`.
2. Desktop:
   - Kiểm tra: phần Comment (bên phải) cố định khi cuộn trang.
   - Khi cuộn, chỉ phần nội dung trái (content) cuộn.
   - Input bình luận luôn ở đáy panel.
3. Mobile:
   - Comment nằm dưới cùng (không cố định), requester card hiển thị dạng xuống dòng.
4. Kiểm tra design modal: có hiển thị thông tin người yêu cầu ở panel thông tin modal.

## Ghi chú / Next steps
- Nếu muốn panel sát mép phải hoặc đổi width (ví dụ 300px), mình có thể thay nhanh.
- Nếu một số modal/designer components bị ảnh hưởng background, có thể thêm ngoại lệ CSS cho các vùng đó.
- Nếu muốn, mình có thể chuyển các block HTML để dùng class `.detail-card` rõ ràng (hiện CSS đã cover `.bg-gray-50.rounded-xl` và `.bg-white.rounded-xl`).

---

Nếu bạn muốn mình tạo commit message mẫu hoặc cập nhật `README.md` với hướng dẫn test, bảo mình biết nhé.