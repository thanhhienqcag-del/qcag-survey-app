# CHANGELOG — 2026-03-19

Tóm tắt các chỉnh sửa và cải tiến đã thực hiện trong ngày 19 March 2026.

---

## Mục tiêu hôm nay

- Xử lý luồng **Sale Heineken gửi yêu cầu chỉnh sửa**: đảm bảo MQ chỉ bị xoá **đúng một lần**, QCAG desktop tự chuyển sang tab "Đang xử lý" và gắn tag "Chờ chỉnh sửa".
- Tự động thêm **bình luận hệ thống** khi QCAG upload lại MQ sau khi có yêu cầu chỉnh sửa, kèm đếm số lần chỉnh sửa.
- Cải thiện các thông tin hiển thị ở **cột trái QCAG Desktop**: chỉ giữ một badge trạng thái trên góc phải, thêm dòng SS/SE, xử lý TBA.
- Thêm **modal nhập kích thước khảo sát** (ngang × cao) cho từng hạng mục, lưu vào `items[*].surveySize`, tự ghi bình luận hệ thống mỗi lần xác nhận.
- Điều chỉnh màu sắc tabs và pill đếm để đọc được cả chế độ sáng lẫn tối.
- Đổi nút "Sửa" kích thước khảo sát thành **icon** (SVG), ẩn spinner number-input.

---

## Files chính đã sửa

### `js/flows/desktop-qcag-flow.js`

- **`qcagDesktopAutoSyncEditRequestedFromComments()`**
  - Thêm kiểm tra `editingRequestedAt`: chỉ xoá `designImages` và set `editingRequestedAt` nếu chưa có — ngăn xoá MQ lặp lại mỗi lần auto-sync.

- **`qcagDesktopUploadMQ(input)`**
  - Khi upload MQ trong trạng thái "Chờ chỉnh sửa" (`qcagDesktopIsPendingEditRequest`), tự động:
    - Tăng `editRevisionCount` lên 1.
    - Thêm comment hệ thống: `"Outlet {tên} đã được chỉnh sửa lần thứ {N} vào lúc {thời gian}."`.
  - Không tăng đếm và không thêm comment nếu không có yêu cầu chỉnh sửa đang chờ.

- **`renderQCAGDesktopList()`**
  - Loại bỏ toàn bộ block tag nhỏ phía trên tên sale; chỉ giữ **badge trạng thái duy nhất** ở góc trên phải mỗi thẻ.
  - Thêm dòng **SS/SE** (`Tên SS/SE: {tên}`) dưới tên sale; hiển thị `"Chức vụ TBA"` (style nhạt) nếu không có dữ liệu.

- **`qcagDesktopBuildItemsHtml(items)`**
  - Khi `item.survey === true`:
    - Nếu đã có `item.surveySize` → hiển thị `{W}m x {H}m` kèm button icon Sửa + note "Kích thước khảo sát" nhỏ bên dưới.
    - Nếu chưa có → hiển thị badge `Khảo sát` + button icon Sửa.
  - Button "Sửa" là icon-only (SVG pencil), không có text.

- **Thêm các hàm modal khảo sát:**
  - `qcagEnsureSurveyModal()` — tạo modal DOM nếu chưa có.
  - `qcagOpenSurveySizeModal(itemIndex)` — mở modal, điền giá trị cũ nếu có.
  - `qcagCloseSurveySizeModal()` — đóng modal.
  - `qcagConfirmSurveySize()` — lấy width/height, lưu vào `items[index].surveySize`, thêm comment hệ thống:
    > `"Outlet {tên}: Xác nhận kích thước khảo sát {loại} là {W}m x {H}m vào {thời gian}."`
    - Lưu cả `items` và `comments` cùng lúc qua `qcagDesktopPersistRequest`.
    - Item **luôn có thể sửa lại** sau khi xác nhận (button Sửa luôn hiển thị).

---

### `js/flows/detail-flow.js`

- **`submitEditRequest()`**
  - Set `editingRequestedAt` thời điểm gửi yêu cầu.
  - Xoá `designImages` nếu có (cùng logic one-time phía client).
  - Sau khi gửi thành công: set `_qcagDesktopStatusFilter = 'processing'` và gọi lại `renderQCAGDesktopList()` để QCAG desktop tự chuyển sang tab Đang xử lý.

---

### `css/desktop.css`

- **Tag / Badge khảo sát**
  - `.qcag-status-badge.survey`: viền **đỏ** ở chế độ sáng, viền **vàng** ở chế độ tối.
  - Loại bỏ tag nhỏ phía trên tên sale trong cột trái.

- **Màu tabs và pill đếm**
  - `.qcag-status-btn`: màu chữ và nền điều chỉnh để đọc được ở light theme.
  - `.qcag-filter-count`: nền tối / chữ trắng mặc định; khi active invert sang nền trắng / chữ tối.
  - Override `.theme-dark` cho cả tabs và filter-count.

- **Survey button (icon)**
  - `.qcag-survey-btn`: `width: 28px`, `height: 28px`, `padding: 0`, `display: inline-flex`, icon SVG pencil 14×14px.
  - Hover: nền nhạt `rgba(0,0,0,0.04)`.
  - `.theme-dark .qcag-survey-btn`: màu icon `#e5e7eb`.

- **Note kích thước khảo sát**
  - `.qcag-survey-size-note`: font-size **9px**, `white-space: nowrap`, `overflow: hidden`, `text-overflow: ellipsis` — không bao giờ tràn qua button Sửa.

- **Ẩn spinner number input**
  - WebKit: `input[type=number]::-webkit-inner-spin-button, ::-webkit-outer-spin-button { appearance: none }`.
  - Firefox: `input[type=number] { -moz-appearance: textfield }`.

- **Modal khảo sát**
  - `.qcag-survey-modal`, `.qcag-survey-backdrop`, `.qcag-survey-panel`, `.qcag-survey-header`, `.qcag-survey-body`, `.qcag-survey-actions`.
  - 2 input label nằm cạnh nhau (`display: flex; gap: 10px`).
  - Dark theme overrides: `.theme-dark .qcag-survey-panel`, `.theme-dark .qcag-survey-actions .btn`.

---

## Tóm tắt hành vi sau bản cập nhật

| Sự kiện | Hành vi |
|---|---|
| Sale Heineken gửi yêu cầu chỉnh sửa | MQ xoá **1 lần**, QCAG desktop chuyển sang tab Đang xử lý |
| QCAG upload MQ khi có yêu cầu chỉnh sửa | `editRevisionCount++`, bình luận hệ thống tự động ghi vào timeline |
| QCAG nhấn button kích thước khảo sát (icon ✏️) | Modal mở, nhập ngang × cao, nhấn Xác nhận → lưu + bình luận hệ thống |
| Sau khi xác nhận kích thước | Hiển thị kích thước + button Sửa luôn hiện → có thể sửa lại bất kỳ lúc nào |
| Text "Kích thước khảo sát" | Font 9px, truncate bằng ellipsis nếu quá dài |
