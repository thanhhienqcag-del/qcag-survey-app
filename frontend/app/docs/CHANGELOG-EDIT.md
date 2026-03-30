# Changelog — Các chỉnh sửa trong phiên làm việc

Ngày: 2026-03-07

## Tổng quan

- Mục tiêu: Thêm loại yêu cầu mới và cải thiện UI/UX cho form "Tạo Yêu Cầu Mới".
- Phạm vi: chỉnh sửa HTML/JS/CSS trong thư mục `KS Mobile 1.0`.

## Tính năng chính & thay đổi

- Thêm loại sign mới: **Logo indoor 2 mặt (Emblemd)** — mặc định Brand = `Tiger`.
- Với loại Emblemd, `brand` hiển thị cố định (label) và selector brand bị ẩn.
- Thêm toggle per-item **Yêu cầu khảo sát**: khi bật → ẩn trường kích thước & trụ và bỏ qua validation tương ứng.
- Nếu có ít nhất 1 item bật khảo sát → Quick-fill đặc biệt **Theo khảo sát** xuất hiện ở Tab 3.
- Dropdown loại bảng ở các item thứ 2 trở đi mở theo kiểu **dropup** (mở lên trên).
- Sau khi chọn loại cho item thứ 2+, tự động cuộn item đó vào giữa màn hình để nhìn thấy nội dung mới hiển thị.
- Nút **Dán** ở ô `Outlet Code`: chỉ chấp nhận chính xác 8 chữ số; nội dung dán không hợp lệ sẽ bị từ chối và báo lỗi.
- Ô `Outlet Code` (gõ tay) chỉ cho nhập số, tối đa 8 chữ số.
- Thêm toggle **New Outlet**: điền `New Outlet`, khoá ô (readOnly), ẩn nút dán và hiển thị icon khoá; validation cho phép literal `New Outlet` khi toggle bật.
- Chuẩn hoá số điện thoại VN: `+84` / `84` → leading `0`; cho phép 11 chữ số khi bắt đầu `02`, còn lại là 10 chữ số.
- Quick-fill (Tab 3) hiển thị ghi chú nhỏ: **Bạn có thể chỉnh sửa nội dung nếu cần** khi nội dung được điền tự động bằng quick-fill.
- Thiết lập luồng điền theo thứ tự (sequential flow):
  - Không cho chuyển sang Tab 2 nếu Tab 1 chưa hoàn tất.
  - Không cho chuyển sang Tab 3 nếu Tab 2 chưa hoàn tất.
  - Tabs bị khóa hiển thị kiểu `tab-locked` (màu xám, cursor not-allowed).
  - Sau khi mở Tab 3, người dùng có thể chuyển tự do; nếu quay lại và làm thiếu dữ liệu, sẽ lại bị chặn.
- Vị trí (Định vị): sau khi lưu vị trí xuất hiện 1 button chiếm phần còn lại của hàng; button `Định vị` giữ kích thước cố định, button action bên phải giãn ra và cắt ngắn địa chỉ bằng ellipsis.

## File chính đã sửa

- `KS Mobile 1.0/js/core/state.js` — thêm loại chữ ký mới, biến `isOldContent` (tồn tại) được sử dụng.
- `KS Mobile 1.0/js/shared/utils.js` —
  - Thêm `normalizeVietnamPhone(raw)` để chuẩn hoá prefix `+84/84`.
  - Cập nhật `sanitizeIntegerInput(el)` dùng normalize.
  - Thêm `sanitizeOutletCodeInput(el)` (số chỉ, tối đa 8 chữ số).
- `KS Mobile 1.0/js/flows/request-flow.js` —
  - Thêm flag `survey`, `toggleSurvey(id)`, `updateRequestItem()` set default brand cho Emblemd.
  - Render: dropup cho item >= 2, fixed brand label cho Emblemd.
  - Auto-scroll sau khi chọn loại cho item thứ 2+.
  - Quick-fill logic + note hiển thị khi quick-filled.
  - `pasteToOutletCode()` validate 8 chữ số; `toggleNewOutlet()` logic lock/unlock.
  - Validation Tab1/Tab2 cập nhật (outlet 8 chữ số, phone normalization, skip size/poles when survey).
  - Thêm helpers `isTab1Complete()` và `isTab2Complete()` cho tab-locking.
- `KS Mobile 1.0/js/flows/warranty-flow.js` — áp dụng sanitize/validate tương tự cho form warranty.
- `KS Mobile 1.0/js/shared/location.js` —
  - `setLocationPreview()` hiển thị `locationActionBtn` (button chiếm phần còn lại) thay vì text thuần.
  - Thêm `clearLocationPreview()`.
- `KS Mobile 1.0/js/core/router.js` —
  - `switchTab()` khóa/giải khóa các tab dựa trên `isTab1Complete()` / `isTab2Complete()` và đổi class `tab-locked`.
- `KS Mobile 1.0/index.html` —
  - `outletCode` & `wOutletCode` gọi `sanitizeOutletCodeInput(this)`.
  - Layout Tab 3 quick-fill chuyển note ngay dưới textarea, thẳng hàng với controls.
  - Vị trí: `#locateBtn`, `#locationPreviewText`, `#locationActionBtn` markup để hỗ trợ layout hai nút cùng hàng.
- `KS Mobile 1.0/css/base.css` —
  - Thêm `.tab-locked` style, `dropup` rules, `.input-locked` overrides, spacing nhỏ cho Tab1.
  - Thêm `location-row` / `.locate-btn` / `.location-action-btn` styles: đồng chiều cao, truncate, flex sizing (min-width:0) để tránh overflow.

## Hành vi kiểm thử (manual)

- Tab locking: confirm cannot go forward until required fields completed.
- Outlet Code: typing/pasting rules; New Outlet toggle behavior.
- Phone: +84 normalization, 02→11 digits exception.
- Items: dropup + auto-scroll + survey toggle hide/show fields.
- Quick-fill: note appears and is editable; editing the textarea removes the note.
- Location: action button appears, truncates text, does not overflow.

## Gợi ý tiếp theo (tùy chọn)

- Bổ sung ARIA/tooltip cho các button mới (lock, new outlet, paste) để cải thiện accessibility.
- Thêm helper text dưới ô `Outlet Code` giải thích quy tắc 8 chữ số.
- Middle-truncation cho địa chỉ (phức tạp hơn) nếu cần hiển thị cả phần đầu và phần cuối.

---

File đã tạo: `KS Mobile 1.0/CHANGELOG-EDIT.md`
