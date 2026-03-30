# CHANGELOG — 2026-03-16

Tóm tắt các chỉnh sửa và cải tiến đã thực hiện trong ngày 16 March 2026.

---

## Mục tiêu hôm nay
- Sửa lỗi đồng bộ/hiển thị request (QCAG không thấy request từ Heineken) — (đã xử lý trước đó trong phiên làm việc).
- Deploy thử nghiệm lên Vercel (đã chạy `vercel --prod` thành công từ thư mục dự án).
- Đại tu UI chi tiết request cho giao diện Desktop QCAG, thêm gallery +N, overlay gallery, tích hợp fullscreen zoom, xử lý propagation để tránh logout vô ý.
- Hiển thị "Khảo sát" dưới dạng badge có màu khác theo theme (sáng = đỏ, tối = vàng) ở cả view QCAG và view Sale (chi tiết request).

---

## Files chính đã sửa
- [js/flows/desktop-qcag-flow.js](js/flows/desktop-qcag-flow.js)
  - Thay đổi layout chi tiết request cho QCAG: tách 2 sub-card trái/phải, render `Nội dung bảng hiệu` và `Hiện trạng Outlet` theo yêu cầu.
  - Thêm giao diện "đại diện ảnh" (representative +N) với class `.qcag-gallery-rep` và hàm mở gallery `qcagOpenGalleryEncoded()` / `qcagOpenGallery()` / `qcagCloseGallery()`.
  - Hiển thị `oldContent` (ảnh cũ) ở subcard trái; nếu có `oldContentExtra` hiển thị block "Nội dung bổ sung:" (chỉ khi tồn tại).
  - Cập nhật hàm `qcagDesktopBuildItemsHtml()` để khi `item.survey === true` hiển thị `Khảo sát` (ban đầu dưới dạng plain text, sau được chuyển thành badge ở bước sau).
  - Thêm stopPropagation cho các tương tác gallery để tránh kích hoạt hành động nền (ví dụ logout).

- [js/flows/detail-flow.js](js/flows/detail-flow.js)
  - Chỉnh sửa `showRequestDetail()` để hiển thị `Khảo sát` dưới dạng `<span class="qcag-survey-badge">Khảo sát</span>` ở cả mobile và desktop (bảng hạng mục), đảm bảo Sale khi xem chi tiết request thấy badge giống QCAG.
  - Giữ nguyên logic kiểm tra quyền sở hữu request và gọi lại `showRequestDetail` sau các cập nhật comment/field.

- [css/desktop.css](css/desktop.css)
  - Thêm/điều chỉnh các lớp liên quan đến gallery: `.qcag-gallery-rep`, `.qcag-img-more`, `.qcag-gallery-overlay`, `.qcag-gallery-thumbs`, `.qcag-gallery-thumb`, `.qcag-gallery-close`.
  - Thêm rule cho `.qcag-survey-badge` (đã thêm ở base.css cũng, vì scope desktop trước đó).
  - Các style cho `qcag-supplement` ("Nội dung bổ sung:") — kích thước chữ nhỏ hơn, italic.
  - Backdrop blur cho gallery overlay, thumbnail sizing thống nhất (120px), z-index tune để zoom overlay nằm trên gallery.

- [css/base.css](css/base.css)
  - Thêm style toàn cục cho `.qcag-survey-badge`: mặc định **màu đỏ** (#ef4444) và override cho dark theme (class `.theme-dark`, `body.dark`, `.dark` hoặc `prefers-color-scheme: dark`) thành **màu vàng** (#facc15).
  - Tăng z-index / điều chỉnh các quy tắc liên quan zoom overlay (`#dvZoomOverlay`, `.dv-zoom-close`, `.dv-zoom-bottom`) để fullscreen zoom luôn nổi trên gallery.

---

## Bổ sung cập nhật (16 March 2026 - lần chỉnh gần nhất trong phiên này)

- Thêm thanh bộ lọc khu vực trên thanh header chi tiết QCAG: thay thế nhóm nút trạng thái/loại bằng 8 nút khu vực trải đều ngang.
  - File: [index.html](index.html)
  - Mô tả: thay thế `.qcag-detail-filter-bar` bằng 8 nút: `Tất Cả`, `S4 Hậu Giang`, `S5 Cà Mau`, `S16 An Giang`, `S17 Kiên Giang`, `24 Kiên Giang`, `S19 Bạc Liêu`, `MOT8 Phú Quốc`.

- CSS cho nút khu vực
  - File: [css/desktop.css](css/desktop.css)
  - Mô tả: cập nhật `.qcag-detail-filter-bar` và `.qcag-detail-filter-btn` để các nút chia đều chiều ngang (`display:flex` + `flex:1` trên nút), điều chỉnh padding và gap để hiển thị tốt với 8 nút.

- JavaScript: thêm bộ lọc khu vực
  - File: [js/flows/desktop-qcag-flow.js](js/flows/desktop-qcag-flow.js)
  - Mô tả: thêm biến trạng thái `let _qcagDesktopRegionFilter = 'all'`, hàm `qcagDesktopSetRegionFilter(region)` để chuyển active state và render lại danh sách, và bổ sung logic lọc theo `requester.region` trong `getQCAGDesktopVisibleRequests()`.
  - Ghi chú: vùng `MOM8` đã đổi thành `MOT8` theo yêu cầu; mảng `regions` giờ chứa `'MOT8'`.

- Thay thế nhãn `MOM8` → `MOT8`
  - File: [index.html](index.html), [js/flows/desktop-qcag-flow.js](js/flows/desktop-qcag-flow.js)
  - Mô tả: cập nhật `id`, `onclick` và label của nút Phú Quốc để dùng `MOT8`.

- Kiểm tra nhanh
  - Tìm thấy một số occurrences của `MOM8` chỉ còn nằm trong các file đóng gói sao lưu trong thư mục `_zip_extract*` (ví dụ các `data.json` bên trong thư mục giải nén). Những file này là bản sao nén/backup và không ảnh hưởng UI hiện tại. Nếu bạn muốn, tôi có thể thay luôn trong các file `_zip_extract*`.

---

Nếu cần tôi có thể:
- Thêm các liên kết line-number cụ thể trong các file đã sửa.
- Thay luôn `MOM8` → `MOT8` trong các file `_zip_extract*`.


## Các tính năng / sửa lỗi chính
- Gallery thumbnails +N
  - Hiển thị thumbnail đại diện với badge +N nếu có nhiều ảnh. Click mở gallery centered panel.
  - Gallery panel có backdrop blur; click vùng blur đóng gallery; click thumbnail mở fullscreen zoom (`showImageFull(src)`).
  - Ngăn propagation để tránh logout khi click vùng overlay hoặc thumbnail.

- Fullscreen zoom
  - Tái sử dụng `js/flows/detail-flow.js` existing zoom viewer; sửa z-index để zoom luôn nằm trên gallery panel.

- "Khảo sát" badge
  - Ở mọi nơi hiển thị hạng mục (QCAG desktop list/detail, Sale detail), khi `item.survey === true` sẽ hiển thị badge HTML:

```html
<span class="qcag-survey-badge">Khảo sát</span>
```

  - Màu sắc:
    - Theme sáng: màu chữ đỏ (#ef4444).
    - Theme tối (class `.theme-dark` / `body.dark` / `prefers-color-scheme: dark`): màu chữ vàng (#facc15).

- Hiển thị nội dung cũ / bổ sung
  - Nếu request có `oldContent === true` và `oldContentImages` thì show representative image (mở gallery) + nếu `oldContentExtra` tồn tại thì hiện block "Nội dung bổ sung:" kèm nội dung (preserve newlines, escaped).

- Items table
  - Ở QCAG và Sale detail, cột Kích thước hiển thị `Khảo sát` cho item có `survey=true`; nếu `useOldSize` thì `KT cũ`, ngược lại hiển thị `{width}m x {height}m`.

## Commit / Deploy
- Các thay đổi đã lưu vào file trong workspace (các file liệt kê ở trên).
- Tôi đã chạy `vercel --prod` từ thư mục dự án (Terminal exit code 0) để deploy thử; nếu bạn muốn tôi redeploy sau khi đồng ý thay đổi CSS final, tôi có thể chạy lại.

## Hướng dẫn kiểm tra nhanh (local)
1. Mở trang chi tiết một request có item bật `survey` — kiểm tra cột "Kích thước" hiển thị badge đỏ (theme sáng) hoặc vàng (theme tối).
2. Ở QCAG desktop: mở request có `oldContent` và `oldContentImages` — click thumbnail đại diện để mở gallery, click ngoài panel để đóng, click thumbnail mở fullscreen zoom.
3. Kiểm tra không còn sự cố logout khi click overlay.
4. Nếu muốn test deploy production: từ repo root chạy:

```powershell
cd "f:\10. Code\Khảo Sát Mobile\KS Mobile 1.4\KS Mobile 1.0"
vercel --prod
```


## Gợi ý tinh chỉnh (tùy chọn)
- Badge style: hiện là chữ màu; nếu muốn đổi thành pill (nền đỏ/vàng + chữ trắng), tôi có thể cập nhật CSS `.qcag-survey-badge` để thêm background, padding, border-radius.
- Kích thước thumbnail: hiện là 120px; nếu cần nhỏ hơn hoặc lớn hơn, chỉnh `css/desktop.css` thumb rule.
- Blur/matte của overlay: điều chỉnh `backdrop-filter: blur(6px)` trong CSS cho nhẹ/mạnh hơn.

## Files tham chiếu
- Chi tiết thay đổi và vị trí code: [js/flows/desktop-qcag-flow.js](js/flows/desktop-qcag-flow.js), [js/flows/detail-flow.js](js/flows/detail-flow.js), [css/desktop.css](css/desktop.css), [css/base.css](css/base.css).

---

Nếu bạn muốn tôi cập nhật file Markdown này (ví dụ thêm code-diff, link line-number cụ thể, hoặc đổi phong cách badge), cho biết yêu cầu cụ thể và tôi sẽ chỉnh tiếp.

