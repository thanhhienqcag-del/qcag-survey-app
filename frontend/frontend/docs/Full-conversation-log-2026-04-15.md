# Toàn bộ cuộc hội thoại & ghi chép kỹ thuật

**Ngày:** 2026-04-15

## Mục đích
Tài liệu này ghi lại toàn bộ tiến trình làm việc trong cuộc hội thoại: từ fix push, xây POC tra cứu ĐVHC, đến phát triển lại modal ĐVHC hiển thị lịch sử sáp nhập 2-cấp, cùng các quyết định dữ liệu và thay đổi mã nguồn đã thực hiện.

---

## Tóm tắt các pha chính

- Pha 1: Sửa lỗi push notification cho Heineken mobile (khắc phục fetch fire-and-forget). (Đã hoàn thành trước khi chuyển sang ĐVHC.)

- Pha 2: Tạo nhanh panel lookup ĐVHC 1-cấp (button ở header, modal, flat search) dùng ThangLeQuoc JSON. (Đã triển khai ban đầu, sau đó bị từ chối theo yêu cầu nâng cấp.)

- Pha 3 (chính): Yêu cầu nâng cấp — cần hiển thị lịch sử **2-cấp**:
  - Cấp 1: tỉnh/thành mới, kèm danh sách tỉnh cũ nguồn sáp nhập.
  - Cấp 2: danh sách xã/phường mới; mỗi xã/phường kèm "Sáp nhập từ (các xã/phường trước sáp nhập)"; nếu trùng tên thì kèm huyện/province để phân biệt.

---

## Tài nguyên dữ liệu được dùng
Nguồn: trongthanh/wx-tra-cuu-dvhcvn (github raw / jsdelivr CDN)

Base CDN: `https://cdn.jsdelivr.net/gh/trongthanh/wx-tra-cuu-dvhcvn@main/public/data/`

Tệp chính:
- `new_wards.csv` (ward_code, ward_name, province_name) — chứa tên tỉnh (chuỗi), có ghi nhận các trường có newline trong quotes.
- `old_wards.csv` (ward_code, ward_name, district_name, province_name) — ~706KB, chứa tên cũ, cần để hiển thị nguồn sáp nhập; có nhiều trường có newline trong quotes.
- `ward_mappings.csv` (new_ward_code, old_ward_code) — mapping many-to-many, khóa chính là `new_ward_code`.

Ngoài ra còn có `new_provinces.csv` và `old_provinces.csv` (không bắt buộc vì tên tỉnh đã có trong ward CSV).

---

## Các phát hiện quan trọng
- `new_wards.csv` lưu `province_name` ở dạng chuỗi (không phải code) → tiện hiển thị trực tiếp.
- `ward_mappings.csv` chỉ chứa mã (code) của wards (mới → cũ), không có tên; cần `old_wards.csv` để lấy tên cũ + huyện + tỉnh.
- `old_wards.csv` có các trường chứa newline trong chuỗi được quote → cần parser CSV hỗ trợ quoted fields và embedded newlines.

---

## Thay đổi mã nguồn đã thực hiện
(Đã áp dụng và lưu vào repo trong thao tác trước)

1. File: `frontend/app/js/flows/desktop-qcag-flow.js`
   - Xóa/loại bỏ block tra cứu ĐVHC cũ (`_qcagDVHCData`, `_qcagDVHCFlat`, `_DVHC_JSON_URL`, v.v.).
   - Thêm implement mới:
     - Lazy-load 3 CSV (`new_wards.csv`, `old_wards.csv`, `ward_mappings.csv`) song song từ CDN.
     - `_dvhcParseCsv(text)`: parser CSV tự viết (RFC-4180 tinh gọn) xử lý quoted fields, escaped quotes, embedded newlines.
     - Build maps: `_dvhcNewWards`, `_dvhcOldWards`, `_dvhcMappings`.
     - Duyệt và tạo `_dvhcIndex` nhóm theo `newProvinceName` với `oldProvinceList` và `wards[]`.
     - Tìm kiếm tokenized match trên: tên xã/phường mới, tên xã/phường cũ, tên huyện cũ, tên tỉnh (mới + cũ).
     - Render 2-cấp HTML: tiêu đề tỉnh mới (`🏙️ {Tỉnh mới}: Sáp nhập từ (...)`) và danh sách các `• {Xã mới}: Sáp nhập từ (...)`.
     - Giới hạn hiển thị (performance caps): max 30 wards khi chỉ match province, max 300 wards tổng, top 30 per province when needed.

2. File: `frontend/app/css/desktop.css`
   - Thêm/điều chỉnh CSS để hỗ trợ layout 2-cấp:
     - `.qcag-dvhc-province-group`, `.qcag-dvhc-province-title`, `.qcag-dvhc-ward-list`, `.qcag-dvhc-ward-item`, `.qcag-dvhc-ward-name`, `.qcag-dvhc-ward-sources`.
   - Dark theme variants cho class mới.

3. File: `frontend/docs/DVHC-change-report-2026-04-15.md` — báo cáo ngắn đã tạo (nội dung tóm tắt thay đổi + hướng dẫn test).

4. File: `frontend/docs/Full-conversation-log-2026-04-15.md` — (tệp này) ghi lại toàn bộ cuộc nói chuyện và các quyết định chính.

---

## Lý do chọn giải pháp (tóm tắt)
- Không cần thêm package; parser CSV nhỏ đủ cho dữ liệu hiện tại.
- Tải 3 CSV ở client là nhanh để triển khai nhanh, và cho phép xây dựng index động để hỗ trợ tìm kiếm theo nhiều trường (ward/district/province cũ/mới).
- Hiển thị 2-cấp đáp ứng yêu cầu UX: tỉnh mới → danh sách xã mới + nguồn sáp nhập.

---

## Hướng dẫn kiểm thử nhanh (manual)
1. Mở `frontend/index.html` trên trình duyệt hoặc chạy dev server.
2. Click nút `🗺️ Tra cứu ĐVHC`.
3. Nhập tìm kiếm ví dụ: `gò vấp`, `An Lạc`, `Thành phố Hồ Chí Minh`.
4. Kỳ vọng: kết quả nhóm theo tỉnh mới; tiêu đề tỉnh hiển thị danh sách tỉnh cũ; mỗi xã/phường có dòng nhỏ "Sáp nhập từ: ...". Các từ khớp được đánh dấu bằng `<mark>`.

---

## Rủi ro / Hạn chế
- Kích thước `old_wards.csv` ~706KB có thể gây chậm với kết nối yếu; hiện chưa có caching bền (session-only).
- Parser CSV tự viết có thể chưa bao quát mọi edge-case CSV lạ — nếu dữ liệu thay đổi định dạng, cân nhắc dùng thư viện CSV đáng tin cậy.
- Không có unit tests tự động cho parser / index / render; hiện chỉ có kiểm thử thủ công.

---

## Gợi ý cải tiến tiếp theo
- Thêm caching (IndexedDB/localStorage) để tránh tải lại CSV trên các lần mở modal.
- Thêm pagination cho các tỉnh có nhiều xã/phường.
- Thêm bộ lọc theo loại (xã/phường), theo huyện, hoặc lựa chọn hiển thị chỉ các xã/phường có mapping.
- Thêm unit tests cho `_dvhcParseCsv` và cho logic build `_dvhcIndex`.

---

## Trạng thái hiện tại
- Các chỉnh sửa đã được áp dụng và lưu vào repo.
- Một báo cáo ngắn (`DVHC-change-report-2026-04-15.md`) và file log đầy đủ (này) đã được thêm vào `frontend/docs/`.
- Hiện tạm dừng chỉnh sửa theo yêu cầu — chờ phản hồi hoặc chỉ dẫn tiếp theo.

---

*Nếu bạn muốn, tôi có thể:*
- Commit các thay đổi vào git với message rõ ràng (y/n),
- Chạy kiểm thử manual tự động (khởi chạy dev server nếu repo có script),
- Thêm caching hoặc unit tests nhỏ cho parser.

