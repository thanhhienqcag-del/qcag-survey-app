# Báo cáo thay đổi — ĐVHC (2-cấp)

**Ngày:** 2026-04-15

## Tóm tắt ngắn
Tôi đã thay thế phần tra cứu Đơn Vị Hành Chính (ĐVHC) hiện có bằng một triển khai mới hỗ trợ hiển thị lịch sử sáp nhập theo 2 cấp: cấp 1 là tỉnh/thành mới (kèm danh sách tỉnh cũ nguồn sáp nhập), cấp 2 là danh sách xã/phường mới kèm nguồn (tên xã/phường cũ + phân biệt huyện/tỉnh nếu cần). Triển khai dùng 3 CSV từ repo trongthanh/wx-tra-cuu-dvhcvn và một parser CSV nội bộ để xử lý các trường có newline.

## File đã chỉnh sửa
- `app/js/flows/desktop-qcag-flow.js` — thay thế toàn bộ khối ĐVHC bằng triển khai mới 2-cấp, loader CSV, index, tìm kiếm và render HTML.
- `app/css/desktop.css` — thêm/ thay đổi kiểu để hiển thị nhóm tỉnh, tiêu đề tỉnh, danh sách xã/phường và dark-theme variants.

(File paths tương ứng: frontend/app/js/flows/desktop-qcag-flow.js, frontend/app/css/desktop.css)

## Dữ liệu và nguồn
- CDN base: `https://cdn.jsdelivr.net/gh/trongthanh/wx-tra-cuu-dvhcvn@main/public/data/`
- Tệp tải về (song song):
  - `new_wards.csv` (ward_code, ward_name, province_name)
  - `old_wards.csv` (ward_code, ward_name, district_name, province_name)
  - `ward_mappings.csv` (new_ward_code, old_ward_code)
- Lý do: `new_wards.csv` có `province_name` dạng chuỗi nên không cần join provinces. `old_wards.csv` cần để lấy tên xã/huyện/province cũ cho phần "Sáp nhập từ".

## Kỹ thuật chính
- Thư viện/logic tự viết (không thêm dep):
  - `_dvhcParseCsv(text)`: parser RFC-4180 tối giản nhưng xử lý quoted fields có newline và escaped quotes.
  - Dùng `Map` để build: `_dvhcNewWards`, `_dvhcOldWards`, `_dvhcMappings`.
  - Tạo `_dvhcIndex` nhóm theo `newProvinceName` với `oldProvinceList` và `wards[]` (mỗi ward chứa `newWardName`, `oldWardLabels`, `wardSearchable`).
- Tìm kiếm:
  - Tokenize truy vấn; so khớp trên: tên xã/phường mới, tên xã/phường cũ, tên huyện cũ, tên tỉnh (mới + cũ).
  - Kết quả nhóm theo tỉnh mới; province title hiển thị: `🏙️ {Tỉnh mới}: Sáp nhập từ ({danh sách tỉnh cũ})`.
  - Mỗi ward show: `• {Xã mới}` và dòng nhỏ `Sáp nhập từ: (các xã cũ)`; nếu trùng tên cũ thì kèm `- {Huyện}` hoặc `- {Tỉnh}` để phân biệt.
- Giới hạn hiển thị để tránh chậm: cap tổng ward hiển thị, cap 30 wards khi chỉ match province, cap 300 wards tổng.

## UI / CSS
- Thêm các class: `.qcag-dvhc-province-group`, `.qcag-dvhc-province-title`, `.qcag-dvhc-ward-list`, `.qcag-dvhc-ward-item`, `.qcag-dvhc-ward-name`, `.qcag-dvhc-ward-sources`.
- Hỗ trợ dark-theme bằng các biến màu riêng cho các class mới.

## Những điều đã kiểm tra (sanity)
- `old_wards.csv` sample kiểm tra thấy có dòng chứa newline trong trường `district_name`/`province_name` — parser xử lý trường hợp này.
- Các tham chiếu cũ đến `_qcagDVHCData`, `_qcagDVHCFlat`, `_DVHC_JSON_URL` đã bị loại bỏ.

## Hướng dẫn nhanh kiểm thử (manual)
1. Mở `frontend/index.html` trên trình duyệt (hoặc môi trường dev hiện có).
2. Click nút `🗺️ Tra cứu ĐVHC` (đã thêm trước đó).
3. Trong ô tìm kiếm nhập ví dụ: `gò vấp`, `An Lạc`, `Thành phố Hồ Chí Minh`.
4. Quan sát: kết quả nhóm theo tỉnh; tiêu đề tỉnh hiển thị danh sách tỉnh cũ; mỗi xã/phường kèm nguồn sáp nhập.

## Rủi ro & Lưu ý
- Kích thước `old_wards.csv` ~706KB — tải lần đầu có thể chậm trên mạng yếu. Dữ liệu được tải lazy khi mở modal.
- Parser tự viết đủ cho dữ liệu hiện tại nhưng chưa stress-test toàn diện trên edge-case CSV khác.
- Không có caching bền; mỗi mở trang giữ dữ liệu trong bộ nhớ cho phiên (không lưu localStorage).

## Phương án rollback
- Quay lại commit trước khi thay đổi hoặc khôi phục block cũ từ lịch sử git (nếu cần ngay lập tức).
- Nếu muốn tạm thời vô hiệu hóa modal mới: comment/disable gọi `qcagDesktopOpenDVHCLookup()` trong `index.html` hoặc thay đổi `onclick` của nút.

## Ghi chú cho người tiếp theo
- Nếu muốn cải thiện hiệu năng: thêm caching (IndexedDB/localStorage) hoặc nén CSV phía server.
- Có thể mở rộng: lọc theo loại (xã/phường), thêm pagination cho tỉnh có nhiều xã.

## Kết luận & trạng thái
- Các chỉnh sửa đã được áp dụng và lưu vào repo (đường dẫn: `frontend/app/js/flows/desktop-qcag-flow.js`, `frontend/app/css/desktop.css`).
- Hiện tạm dừng mọi chỉnh sửa tiếp theo theo yêu cầu — đợi phản hồi/kiểm thử từ bạn.

---
*Báo cáo auto-generated. Nếu cần tôi sẽ commit, chạy test, hoặc chỉnh tiếp theo hướng bạn chỉ định.*
