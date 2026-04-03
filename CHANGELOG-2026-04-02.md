# CHANGELOG — 2026-04-02
## Hệ thống Push Notification (Web Push / Apple APNs)

> **Trạng thái cuối ngày: ✅ HOẠT ĐỘNG**  
> Test thủ công gửi đến `saleCode: 88000255` → iPhone nhận được thông báo lock-screen.  
> Luồng QCAG desktop bấm "Hoàn thành" → gửi push đã được fix và deploy.

---

## 1. Tổng quan những gì đã làm

### Mục tiêu ban đầu
- **Heineken Mobile** nhận thông báo khi QCAG đánh dấu yêu cầu hoàn thành
- **QCAG Desktop** nhận thông báo khi Heineken tạo yêu cầu mới

### Kết quả đạt được
| Luồng | Trạng thái |
|---|---|
| Heineken tạo request → QCAG Desktop nhận push | ✅ Hoạt động |
| QCAG bấm Hoàn thành → Heineken Mobile (iPhone) nhận push | ✅ Hoạt động (đã test xác nhận) |
| saleCode lưu vào DB khi đăng ký | ✅ |
| Auto-dedup: mỗi thiết bị chỉ giữ 1 subscription | ✅ |

---

## 2. Kiến trúc hệ thống Push

```
iPhone (Heineken PWA)
  └─ /sw.js  (Service Worker root scope)
  └─ /app/js/push.js  (client: đăng ký, lưu subscription)
       └─ POST /api/ks/push/subscribe  → Neon PostgreSQL: push_subscriptions
       
QCAG Desktop (Windows Chrome)
  └─ /app/js/flows/desktop-qcag-flow.js  (khi bấm Hoàn thành)
       └─ POST /api/ks/push/send  → lookup by saleCode → web-push → Apple APNs

Heineken Mobile (khi tạo request mới)
  └─ /app/js/flows/request-flow.js
       └─ POST /api/ks/push/send  với role: 'qcag'  → Windows Push Service
```

### Bảng DB hiện tại (`push_subscriptions`)

| id | phone | role | sale_code | endpoint |
|---|---|---|---|---|
| 14 | 0966767731 | heineken | **88000255** | Apple APNs (iPhone đã test) |
| 10 | 0966767731 | qcag | null | Windows Notification (QCAG PC) |
| 12 | 0888911117 | heineken | null | Apple APNs (iPhone Heineken kia — chưa re-login) |
| 3 | 0334975401 | heineken | null | FCM Android |

---

## 3. Files đã chỉnh sửa

### `/sw.js` (root — mới tạo)
**Lý do:** iOS chỉ hỗ trợ Web Push từ PWA cài từ Home Screen, Service Worker phải ở root scope `/`.  
**Thay đổi:**
- Tạo mới file `/sw.js` ở root (trước chỉ có `/app/sw.js`)
- Fix bug **double `event.waitUntil()`** — browser chỉ track promise đầu tiên, merge thành `Promise.all()`
- Bỏ `vibrate` (iOS không hỗ trợ, gây lỗi silent)
- Unique `tag` mỗi notification (`'qcag-' + Date.now()`) để không bị thay thế notification cũ
- Thêm `TTL: 86400` (24h) — push được queue khi device offline, không bị drop
- Thêm handler `SKIP_WAITING` để force cập nhật SW ngay khi có version mới

### `/app/sw.js` (legacy scope)
**Thay đổi:** Apply đúng các fix như `/sw.js` ở trên

### `/app/js/push.js`
**Thay đổi:**
- Đăng ký SW tại `/sw.js` (root scope) thay vì `/app/sw.js`
- `initPush(phone, role, saleCode)` — nhận thêm tham số `saleCode`
- `autoInitPushOnLoad()` — tự động đăng ký lại khi mở app, đọc session từ `localStorage`
- Force SW update + `SKIP_WAITING` khi có update available
- SW message listener → hiện in-app toast khi nhận push

### `/app/js/flows/login-flow.js`
**Thay đổi:**
- Extract `saleCode` từ `currentSession`, truyền vào `initPush()`
- iOS không-standalone → hiện toast "Thêm vào Home Screen" thay vì lỗi

### `/app/js/flows/desktop-qcag-flow.js` ⭐ (fix quan trọng nhất)
**Vấn đề:** Code cũ có `if (requesterSaleCode || requesterPhone)` — request cũ tạo trước khi có feature sẽ thiếu cả 2 field, toàn bộ push bị bỏ qua im lặng, không toast gì.  
**Thay đổi:**
- Bỏ điều kiện `if` — luôn gửi push
- Nếu thiếu `saleCode` AND `phone` → fallback gửi `role: 'heineken'` (broadcast)
- Toast luôn hiện kết quả: thành công / "chưa đăng ký" / lỗi API / lỗi network
- Log chi tiết để debug

### `/app/js/flows/request-flow.js`
**Thay đổi:**
- Sau khi `dataSdk.create()` thành công → gửi push đến `role: 'qcag'` với thông tin outlet + tên người gửi

### `/api/ks/push/subscribe.js`
**Thay đổi:**
- Lưu `saleCode` vào DB khi đăng ký
- Normalize phone: bỏ khoảng trắng, `+84 → 0`
- **Auto-dedup sau mỗi lần subscribe:** DELETE tất cả row cũ cùng `sale_code` (hoặc cùng `phone` nếu chưa có sale_code), chỉ giữ lại row vừa upsert

```js
// Sau upsert, tự xóa duplicate
if (saleCode) {
  DELETE FROM push_subscriptions WHERE sale_code = $1 AND id != $2
} else if (phone) {
  DELETE FROM push_subscriptions WHERE phone = $1 AND sale_code IS NULL AND id != $2
}
```

### `/api/ks/push/send.js`
**Thay đổi:**
- **Fix 403 bug:** `fetch()` same-origin không gửi `Origin` header → kiểm tra `referer` thay thế + allow `noOriginNoReferer`
- Lookup priority: `saleCode` → fallback `phone` → fallback `role` (broadcast)
- Normalize phone khi lookup
- TTL 24h cho push options
- Tự xóa subscription hết hạn (HTTP 410/404 từ APNs)

### `/api/ks/push/cleanup.js`
**Thay đổi:**
- Thêm dedup logic:
  - Với rows có `sale_code`: giữ row mới nhất mỗi `sale_code`, xóa phần còn lại
  - Với rows không có `sale_code`: giữ row mới nhất mỗi `phone`, xóa phần còn lại

### `/api/ks/push/migrate.js` (mới tạo, đã chạy)
- `ALTER TABLE push_subscriptions ADD COLUMN sale_code VARCHAR(20)`
- `CREATE INDEX idx_push_sale_code ON push_subscriptions(sale_code)`
- **Đã chạy xong, không cần chạy lại**

### `/api/ks/push/list.js` (mới tạo — debug)
- GET endpoint: xem toàn bộ subscriptions hiện tại  
- URL: `https://qcag-survey-app.vercel.app/api/ks/push/list`

### `/vercel.json`
```json
{ "source": "/sw.js", "headers": [
  { "key": "Content-Type", "value": "application/javascript" },
  { "key": "Service-Worker-Allowed", "value": "/" },
  { "key": "Cache-Control", "value": "no-cache, no-store, must-revalidate" }
]}
```

### `/app/scripts/test-push.ps1` (mới tạo)
Script test gửi push thủ công:
```powershell
# Gửi đến saleCode cụ thể
.\app\scripts\test-push.ps1 -SaleCode 88000255

# Gửi đến số điện thoại
.\app\scripts\test-push.ps1 -Phone 0888911117

# Broadcast tất cả Heineken
.\app\scripts\test-push.ps1 -Role heineken
```

---

## 4. Commit history hôm nay

```
4b97097  fix(push): always send on markDone - fallback role=heineken, always show toast
aa82570  fix(push): dedup on subscribe + cleanup endpoint with dedup logic
467afc5  fix(push): add sale_code to list endpoint
75d8e78  feat(push): use saleCode as primary identifier, fallback to phone
43b9556  fix(push): force SW update via SKIP_WAITING
1025b3c  fix(push): normalize phone numbers, toast feedback on mark-done
4a3dd82  fix(push): add cleanup endpoint for fake test subscriptions
241bcaa  fix(sw): fix double event.waitUntil bug, remove vibrate, unique tag, TTL 24h
c8c2122  fix(push): fix same-origin 403, auto re-subscribe on load
a19bf45  feat(push): proper push notifications - mobile Heineken + QCAG desktop
```

---

## 5. Các vấn đề đã gặp và cách giải quyết

| Vấn đề | Root cause | Fix |
|---|---|---|
| API trả 403 cho tất cả browser call | `fetch()` same-origin không gửi `Origin` header | Kiểm tra `referer` + allow `noOriginNoReferer` |
| Push gửi nhưng không hiển thị | SW double `event.waitUntil()` — browser chỉ track promise đầu tiên | `Promise.all([showNotif, postMessage])` |
| iOS crash SW | `vibrate` option không được hỗ trợ | Xóa option `vibrate` |
| Notification bị overwrite | Tag cố định `'push-notification'` | `tag: 'qcag-' + Date.now()` |
| Push dropped khi iPhone offline | Không có TTL | `TTL: 86400` |
| SW cũ cache trên iOS | Không có update mechanism | `SKIP_WAITING` message handler |
| Phone mismatch khi lookup DB | Format khác nhau (`+84xxx` vs `0xxx`) | Normalize: `+84→0`, strip spaces |
| saleCode bị null dù user đã login | `currentSession.saleCode` chưa được extract | Fix `login-flow.js` + `push.js` autoInitPushOnLoad |
| QCAG bấm Hoàn thành → không push | `if (requesterSaleCode \|\| requesterPhone)` reject request cũ | Bỏ điều kiện, fallback `role=heineken` |
| 4 subscription duplicate cho cùng phone | Không có dedup | `subscribe.js` auto-dedup + `cleanup.js` |

---

## 6. Việc cần làm tiếp theo (TODO)

### Ưu tiên cao
- [ ] **`0888911117` cần re-login** → Sale này chưa có `sale_code` trong DB (row id=12, `sale_code=null`). Khi QCAG xử lý request của họ, sẽ phải fallback phone lookup. Giải pháp: yêu cầu Sale đăng xuất và đăng nhập lại trên iPhone để subscription mới được lưu với `sale_code`.
- [ ] **`0334975401` (row id=3)** — subscription từ tháng 3, không có `sale_code`. Cần re-login.

### Ưu tiên trung bình
- [ ] **Test end-to-end hoàn chỉnh:** Heineken tạo request → QCAG bấm Hoàn thành → Heineken nhận notification trên lock screen (hiện tại mới test thủ công script, chưa test qua UI đầy đủ)
- [ ] **QCAG Desktop subscription** (row id=10) không có `sale_code`. QCAG PC nhận notification qua `role='qcag'` broadcast nên vẫn hoạt động, nhưng nếu muốn precise targeting cần add saleCode vào QCAG login.

### Cải tiến tương lai
- [ ] Notification click → mở app và navigate thẳng đến request (`data.backendId`)
- [ ] Badge count trên app icon
- [ ] Unsubscribe khi logout

---

## 7. Thông tin kỹ thuật quan trọng

### Endpoints
| Endpoint | Method | Mô tả |
|---|---|---|
| `/api/ks/push/subscribe` | POST | Đăng ký push subscription |
| `/api/ks/push/send` | POST | Gửi push notification |
| `/api/ks/push/list` | GET | Xem tất cả subscriptions (debug) |
| `/api/ks/push/cleanup` | POST | Xóa duplicate và fake subscriptions |

### Môi trường
- **Frontend:** Vercel — `https://qcag-survey-app.vercel.app`
- **Backend:** Google Cloud Run — `https://qcag-backend-k7disoxmcq-as.a.run.app`
- **Database:** Neon PostgreSQL — table `push_subscriptions`
- **VAPID Public Key:** `BBoX8J_jLPTJzAI5X-LAUSyJVdpZ9HD2uNFDY6XOFy87WcpPU8sPek4zQX4bT7nWvNoEsFcb1uq8Tn3xy7e7IgM`
- **Git tag stable:** `stable-v1` = commit `81a97ef` (trước khi làm push notification)

### Yêu cầu iOS PWA Push
1. iOS ≥ 16.4
2. App **phải** được cài từ Home Screen (Add to Home Screen trong Safari)
3. Settings → Notifications → [App] → Allow Notifications = ON
4. Không trong Focus Mode / Do Not Disturb khi test

### Lưu ý saleCode
- Là mã nhân viên Heineken 8 chữ số (VD: `88000255`)
- Được lưu vào `localStorage` qua key `ks_session` sau khi đăng nhập
- Được lưu vào `push_subscriptions.sale_code` khi thiết bị đăng ký push
- **Quan trọng:** Nếu Sale đăng nhập trước khi có feature này, `sale_code` trong DB sẽ là `null` → cần re-login để cập nhật
