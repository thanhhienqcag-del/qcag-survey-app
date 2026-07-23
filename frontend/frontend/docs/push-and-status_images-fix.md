## Tóm tắt thay đổi — Push notification & khóa `status_images`

Mục tiêu: đảm bảo QCAG desktop gửi Web Push tới Sale khi QCAG xác nhận ("Hoàn thành"), và khóa trường `status_images` (không cho xóa/ghi rỗng vô tình) khi patch request.

Nguyên nhân gốc rễ:
- Trên client (QCAG desktop) có một lỗi `ReferenceError` do biến `isSurveySizeIncomplete` được khai báo ở phạm vi block nhưng lại dùng ở bên ngoài — lỗi này gây throw trong hàm `qcagDesktopRefreshMQInPlace()` và khiến luồng trong `qcagDesktopMarkProcessed()` dừng trước khi thực hiện gọi API gửi push.
- Push server (Vercel) và Cloud Run đều có endpoint để gửi push. Vercel `/api/ks/push/send` có subscription trên Neon (Postgres) và hoạt động; Cloud Run không cấu hình VAPID đúng (placeholder) nên không hoạt động — hiện client đang gọi Vercel để gửi push khi sử dụng localhost.
- Có cơ chế bảo vệ `status_images` trên backend: nếu client gửi placeholder/empty cho `statusImages` trong PATCH, backend sẽ giữ nguyên giá trị có trong DB thay vì ghi rỗng.

Các file đã sửa (frontend):
- `app/js/flows/desktop-qcag-flow.js`
  - Sửa scoping bug: di chuyển `const isSurveySizeIncomplete = ...` ra **ngoài** `if (completeBtn)` để tránh `ReferenceError`.
  - Chuyển sang gửi PATCH "slim" (không gửi ảnh lớn), cập nhật trạng thái nhanh trên UI trước khi gọi push.
  - Fix push endpoint cho trường hợp đang chạy trên `localhost` bằng cách sử dụng URL tuyệt đối `https://qcag-survey-app.vercel.app/api/ks/push/send`.
  - Thêm debug toasts để hiển thị trạng thái gọi push trên UI: hiển thị `⏳ Gửi push → {saleCode|phone}`, rồi `📲 Push đã gửi (sent:n)` hoặc `⚠️ Push: {...}` hoặc `❌ Push error: ...`.
  - Cập nhật tiêu đề/nội dung push theo yêu cầu: tiêu đề `QCAG uploaded to MQ`, body `Outlet "{tên outlet}" đã có MQ, vui lòng mở app để xem chi tiết`.

- `index.html`
  - Bump query string phiên bản `v=20260418f` → `v=20260418g` (lần cuối là `v=20260418f`, đã bump lên `v=20260418f` trong commit — đảm bảo force reload). (Trong repo hiện tại đã bump lên `v=20260418f` và sau commit là `v=20260418f`.)

Backend liên quan (đã kiểm tra, không sửa trong commit này):
- `backend/index.js`
  - Hàm `ksRowToApp()` đảm bảo `requester` là string: `requester: row.requester || '{}'`.
  - Logic xử lý PATCH bảo vệ `status_images`: nếu incoming `statusImages` là placeholder/empty trong body, backend sẽ giữ nguyên `status_images` trong DB (đoạn code kiểm tra và `delete b.statusImages` khi cần).
  - Hàm `sendKsPush()` gửi push từ backend khi điều kiện `becomingDone` thoả — nhưng lưu ý Cloud Run chưa có VAPID key thực tế (publicKey trả về `"<public>"`), vì vậy gửi từ Cloud Run sẽ không hoạt động cho tới khi VAPID được cấu hình.

Hành vi bảo vệ `status_images` (chi tiết kỹ thuật):
- Khi backend nhận PATCH, trước khi xử lý ảnh, có kiểm tra:
  - Nếu client gửi `statusImages` là placeholder/empty (ví dụ `[]` hoặc một giá trị placeholder), và DB đang có `status_images` chứa URL thực, backend **sẽ xóa khóa `statusImages` khỏi payload** (bằng `delete b.statusImages`) để tránh việc ghi đè/ghi rỗng URL có sẵn trong DB.
  - Nếu client thực sự muốn thay đổi `status_images`, payload phải chứa danh sách URL hợp lệ (hoặc upload đúng flow) — chỉ khi đó backend mới cập nhật.

Kiểm thử thủ công đã thực hiện:
1. Tạo request test trên backend (id=165, TK26.00098) với `requester.saleCode = 88000255`.
2. Trên QCAG desktop localhost: force-reload (Ctrl+Shift+R) để tải code mới (`v=20260418f`).
3. Mở detail request TK26.00098, nhấn `Hoàn thành`.
4. Quan sát các toast: phải thấy `✓ Đã hoàn thành`, `⏳ Gửi push → 88000255`, và `📲 Push đã gửi (sent:1)`.
5. Xác nhận device sale (phone `0966767731`) nhận Notification với tiêu đề `QCAG uploaded to MQ` và nội dung `Outlet "..." đã có MQ, vui lòng mở app để xem chi tiết`.

Rollback / nếu cần revert:
- Revert commit `804ca60` (hoặc trước đó `b209c14`) nếu cần quay lại nhanh.

Ghi chú / đề xuất tiếp theo:
- Đảm bảo VAPID keys được cấu hình trên Cloud Run nếu muốn backend Cloud Run (server-side) gửi push trực tiếp; hiện tại Vercel `/api/ks/push/send` đang hoạt động và là đường an toàn khi client chạy trên localhost.
- Xem xét thêm unit/integration tests cho flow `qcagDesktopMarkProcessed()` và `qcagDesktopRefreshMQInPlace()` để tránh regressions về scope/ReferenceError.

Files changed in this patch (frontend):
- `app/js/flows/desktop-qcag-flow.js` — fix scope bug + push debug + wording
- `index.html` — bump version query string (cache bust)

Contact: nếu cần tôi có thể tạo PR kèm mô tả ngắn và checklist test tự động.

---
Date: 2026-04-18
Author: Dev (thay đổi thực hiện trong workspace)
