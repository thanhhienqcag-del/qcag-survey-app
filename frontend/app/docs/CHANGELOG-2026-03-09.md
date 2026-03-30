# Thay đổi ngày 2026-03-09

Tóm tắt các thay đổi thực hiện trong dự án hôm nay (03/09/2026). Mục tiêu chính: sửa lỗi runtime khiến button không hoạt động, thắt chặt quyền truy cập theo `saleCode`, và cải thiện UX/validation cho form tạo yêu cầu.

## Tổng quan
- Sửa lỗi gây crash (script dừng) do `js/shared/utils.js` bị lỗi trước đó.
- Áp dụng kiểm soát quyền truy cập chặt chẽ: chỉ dùng `saleCode` làm khóa sở hữu (không dùng `phone` fallback).
- Thêm highlight (viền nền/viền) cho các trường bị thiếu dữ liệu trên cả 3 tab của form tạo yêu cầu; tự động xóa highlight khi người dùng sửa trường.
- Cập nhật UI/UX cho tính năng `New Outlet`: input bị khóa có nền/viền màu xanh lá, icon ổ khóa không nền và vẫn màu đỏ; khi bật New Outlet, click vào ô sẽ hiện toast giải thích không thể chỉnh sửa.

## File đã thay đổi (chính)
- `js/shared/utils.js`
  - Thêm logic clear validation trên custom-select khi chọn option (`chooseCustomOption`).

- `js/flows/list-flow.js`
  - Ownership: chỉ so sánh `reqOwner.saleCode === currentSession.saleCode` khi lọc/đếm requests.

- `js/flows/request-flow.js`
  - Ownership predicate trong duplicate-check chuyển sang dùng `saleCode`.
  - Thêm validation highlight cho từng field (Tab1/Tab2/Tab3): thêm/loại bỏ class `field-error` trên input/textarea/custom-select.
  - Thêm hàm realtime clear handlers (xóa đỏ khi user nhập/chọn).
  - Khi bật `New Outlet` khóa `outletCode` và gán handler click hiển thị toast; gỡ handler khi tắt.
  - Thêm id cho vùng upload/textarea để có thể highlight (ví dụ `statusUploadLabel`, `oldContentUploadLabel`).

- `js/flows/detail-flow.js`
  - Ownership guard `isRequestOwnedByCurrentSession` sửa để chỉ dựa vào `saleCode`.

- `css/base.css`
  - Thêm class `field-error` (style viền đỏ) dùng cho highlight validation.
  - Cập nhật style `input.input-locked` (New Outlet) sang màu xanh lá nhẹ + viền xanh (`#16a34a`).
  - Thay đổi màu icon ổ khóa và loại bỏ nền wrapper.

- `index.html`
  - Thêm chú thích (comment) đầu file về ưu tiên phát triển cho Heineken.
  - Gắn id cho các vùng upload cần highlight.

## Hành vi thay đổi (chi tiết)
- Quyền xem chi tiết & danh sách: chỉ những requests có `requester.saleCode` trùng với `currentSession.saleCode` mới hiển thị/chỉ định xem được.
- Validation UX:
  - Khi người dùng nhấn `Tiếp tục` hoặc `Xác nhận` mà còn trường bắt buộc thiếu/sai, app sẽ hiển thị `showToast(...)` như trước và đồng thời tô đỏ từng trường tương ứng (số ô đỏ = số trường thiếu).
  - Khi user bắt đầu nhập/cập nhật trường đó, viền đỏ sẽ tự biến mất (real-time).
- New Outlet:
  - Khi bật: `outletCode` chuyển sang trạng thái khoá (readOnly), có viền + nền xanh lá nhạt; icon khóa hiển thị màu đỏ và không có background wrapper.
  - Click vào ô khi khoá sẽ hiện toast: "Không thể thay đổi trường này khi bật New Outlet. Vui lòng tắt New Outlet để nhập giá trị khác.".

## Kiểm tra đã thực hiện
- Đã chạy `node --check` cho các file JS đã sửa (không phát hiện lỗi cú pháp trên các file đã chỉnh sửa).
- Kiểm tra thủ công logic mapping của các handler và trình tự load script để đảm bảo `js/shared/utils.js` được nạp trước flows.

## Khuyến nghị / bước tiếp theo
1. Bổ sung kiểm tra/kiểm soát quyền tại server (api) — hiện tại là bảo vệ client-side, cần server-side enforcement.
2. Chạy migration để gán `saleCode` (hoặc `ownerId`) cho các record cũ trong `data.json` nếu một số request thiếu `requester.saleCode`.
3. Thêm test end-to-end (manual/automation) cho luồng: tạo request (New Outlet ON/OFF), validate fields, duplicate check, view detail permission.

---
Nếu bạn muốn, tôi có thể:
- Viết script migrate mẫu để cập nhật `data.json` (gán `saleCode`/`ownerId`).
- Thêm server-side sample logic (pseudo-code) để verify quyền khi fetch/patch by id.

Ghi chú: các thay đổi UI/UX hiện nằm trong branch/workspace local — nhớ kiểm tra trên môi trường dev (localhost) trước khi deploy.
