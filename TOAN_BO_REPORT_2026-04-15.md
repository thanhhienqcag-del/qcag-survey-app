# Báo cáo tổng hợp — Dự án QCAG (15-Apr-2026)

> Tệp: TOAN_BO_REPORT_2026-04-15.md
> Tạo bởi: (tự động) — báo cáo tóm tắt toàn bộ thay đổi, trạng thái hiện tại và bước tiếp theo.

## 1. Tóm tắt mục tiêu
- Xây dựng lại giao diện tra cứu ĐVHC (Đơn vị hành chính) với hiển thị lịch sử sáp nhập 2 cấp (Tỉnh/TP -> Phường/Xã), dùng CSV nguồn chính thức.
- Cải thiện trải nghiệm tìm kiếm: chỉ tìm khi nhấn Enter, khớp cả cụm, highlight làm sáng chữ (không background).
- Chuyển modal ĐVHC thành panel cố định dạng dropdown, không chặn tương tác trang, có scroll nội bộ và toggle nút mở/đóng.
- Tích hợp nút mở ĐVHC vào overlay xem ảnh fullscreen.
- Hỗ trợ dán ảnh từ clipboard (Ctrl+V) vào ô bình luận; hiển thị thumbnail preview bên trong ô nhập trên desktop và mobile.
- Di chuyển preview ảnh vào trong vùng input, cập nhật vị trí FAB để không che nội dung/thumbnail.
- Thêm chức năng tải ảnh trong sheet "Yêu cầu chỉnh sửa" (step 2), preview ảnh, gửi ảnh kèm yêu cầu.
- Thay đổi nhãn hành động cho loại Logo: hiển thị `Làm mới` và `Sửa chữa` (thay vì `Làm mới` + `Thay bạt`) trên desktop và mobile.

## 2. File đã chỉnh sửa chính (tóm tắt)
- frontend/app/js/flows/desktop-qcag-flow.js
  - Thêm: bộ phân tích CSV RFC-4180, index dữ liệu ĐVHC, loader, tìm kiếm theo cụm, highlight theo cụm.
  - Thêm: toggle panel ĐVHC, paste image handler cho comment, render preview ảnh trong ô nhập, reflow FAB.
  - Thay đổi: logic action chọn `Sửa chữa` cho Logo trong modal thêm/sửa hạng mục; populate action options khi chọn type.

- frontend/app/js/flows/detail-flow.js
  - Thêm nút DVHC trên overlay ảnh fullscreen; xử lý sheet yêu cầu chỉnh sửa (upload ảnh, preview, submit kèm ảnh); update vị trí FAB.

- frontend/app/js/flows/request-flow.js
  - Mobile: render selector `Hình thức` cho Logo, cung cấp `Sửa chữa` thay `Thay bạt` cho types Logo/Emblemd; validate yêu cầu chọn action cho Bảng/Hộp đèn/Logo.

- frontend/index.html
  - Thêm markup cho edit-request sheet step 2 (preview + file input), header DVHC button gọi toggle.

- frontend/app/css/desktop.css, mobile.css, base.css
  - Điều chỉnh style panel ĐVHC (fixed dropdown), highlight (không background — chỉ brighten), old-province italic và nhẹ màu, preview thumbnails inside input, DVHC button overlay, edit-request preview styles.

## 3. Trạng thái hiện tại (quan trọng)
- Hầu hết các tính năng nêu ở phần 1 đã được triển khai trong mã nguồn (CSV parser, index, search on Enter, highlight, panel, paste/upload preview, FAB reflow, edit-request image upload).
- Gần đây có thay đổi yêu cầu: khi chọn `Logo` trong edit-request step 2, hiển thị hành động `Làm mới` và `Sửa chữa` — thay đổi này đã được áp dụng cho cả desktop và mobile.
- Lưu ý: theo thông tin mới nhất, người dùng đã hoàn tác (undo) một số thay đổi trước đó cho các file sau. Trạng thái hiện tại trên filesystem có thể khác so với thay đổi tôi áp dụng trước đó:
  - `frontend/app/js/flows/desktop-qcag-flow.js` — đã bị hoàn tác bởi người dùng; vui lòng kiểm tra nội dung file này nếu cần hoàn nguyên.
  - `frontend/index.html` — đã bị hoàn tác.
  - `frontend/app/js/shared/location.js` — đã bị hoàn tác.

  (Báo cáo này phản ánh cả lịch sử thay đổi và những bản vá đã thực hiện; nếu bạn muốn, tôi có thể so sánh phiên bản hiện tại với bản đã chỉnh sửa và khôi phục các thay đổi cụ thể.)

## 4. Kiểm thử & Xác minh (hướng dẫn nhanh)
- ĐVHC panel
  - Mở app → nhấn nút DVHC (header hoặc overlay ảnh). Gõ cụm tìm kiếm rồi nhấn Enter → kết quả hiển thị hai cấp (Tỉnh mới, list phường/xã và ghi chú "Sáp nhập từ" cho các mục cũ); matched text sáng hơn.
  - Panel không chặn tương tác trang; có thể scroll nội bộ.

- Fullscreen overlay
  - Trong view ảnh fullscreen, nút DVHC xuất hiện bên cạnh nút đóng; nhấn toggle mở/đóng panel.

- Bình luận & Paste
  - Trong ô bình luận (desktop), Ctrl+V dán ảnh từ clipboard sẽ thêm thumbnail vào preview bên trong ô nhập; FAB di chuyển lên trên preview.

- Edit-request (sheet)
  - Mở sheet (Yêu cầu chỉnh sửa) → chọn category (bao gồm Logo) → Next → step 2: phần nhãn `Loại:` hiển thị các category đã chọn; trường `Hình thức` hiển thị `Làm mới` + `Sửa chữa` khi type liên quan Logo.
  - Upload ảnh: chọn file → thumbnails hiện ở preview; gửi yêu cầu sẽ đính kèm ảnh vào comment JSON.

## 5. Vấn đề đã gặp & Ghi chú kỹ thuật
- CSV nguồn (`old_wards.csv`) có các trường được quote chứa newline — đã dùng parser tuân RFC-4180 để xử lý.
- Một số thay đổi UI cần test trên nhiều trình duyệt (mobile WebKit vs Chrome Android) vì hành vi dán clipboard khác nhau giữa nền tảng.
- Người dùng đã hoàn tác (undo) một số file; cần xác nhận bạn muốn khôi phục mã tôi đã sửa hay giữ trạng thái hiện tại.

## 6. Việc cần làm tiếp (đề xuất)
1. Xác nhận giữ/cập nhật các thay đổi đã hoàn tác:
   - Nếu muốn khôi phục các thay đổi trước đó cho `frontend/app/js/flows/desktop-qcag-flow.js` và `frontend/index.html`, tôi có thể tái áp dụng patchs cụ thể.
2. Chạy thủ công/kiểm tra giao diện trên thiết bị thật (iOS/Android) để kiểm tra paste/upload/preview/FAB behavior.
3. (Tuỳ chọn) Thêm unit tests cho parser CSV và một tập kiểm tra thủ công chi tiết.
4. Commit các thay đổi mong muốn vào Git và tạo PR với mô tả thay đổi.

## 7. Các file quan trọng để kiểm tra (quick links)
- frontend/app/js/flows/desktop-qcag-flow.js
- frontend/app/js/flows/detail-flow.js
- frontend/app/js/flows/request-flow.js
- frontend/index.html
- frontend/app/css/desktop.css
- frontend/app/css/mobile.css
- frontend/app/css/base.css

## 8. Ghi chú cuối
- Tôi đã tạo file này tại: `f:\10. Code\QCAG-Production\App-2-KS-Khao-Sat\TOAN_BO_REPORT_2026-04-15.md`.
- Muốn tôi xuất bản báo cáo này vào README hoặc đẩy commit PR không? Hoặc bạn muốn tôi khôi phục những file đã bị undo trước khi tạo báo cáo cuối cùng? Trả lời ngắn gọn yêu cầu tiếp theo.

---
Cần chỉnh sửa/thu gọn nội dung báo cáo (ví dụ: thêm diff, log git, hoặc ảnh chụp màn hình)? Tôi sẽ cập nhật ngay.