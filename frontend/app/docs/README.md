# KS Mobile — Local test server

This project includes a tiny Node.js server to serve the app on **both** `http://localhost:3000` and `http://localhost:3001` from the same process.
Both ports read/write the same `data.json`, so data is linked in real time.

Prerequisites
- Node.js (>= 14)

Install & run
```bash
cd "g:\10. Code\Khảo Sát Mobile\KS Mobile 1.0"
npm install
npm start
```

Open in browser:
- `http://localhost:3000`
- `http://localhost:3001`

LAN access (devices on same Wi-Fi/LAN):
- `http://<your-ip>:3000`
- `http://<your-ip>:3001`

PowerShell helpers:
- `./start-localhost3000.ps1 -Action start`
- `./start-localhost3001.ps1 -Action start`

Both helpers now manage the same shared server process (avoid duplicate `npm start`).
# KS Mobile

## Mục tiêu
Dự án này dùng để triển khai giao diện/logic khảo sát trên mobile theo hướng **dễ mở rộng, dễ bảo trì, dễ debug**.

---

## Nguyên tắc quan trọng nhất (BẮT BUỘC)

### 1) Tách JavaScript theo module/flow
- **Mỗi flow nghiệp vụ = 1 file JS riêng**.
- Không dồn toàn bộ logic vào một file lớn.
- Không tạo “file tổng” chứa tất cả xử lý cho mọi màn hình/flow.

Ví dụ:
- Flow đăng nhập: `login-flow.js`
- Flow khảo sát: `survey-flow.js`
- Flow upload ảnh: `upload-flow.js`
- Flow tổng hợp kết quả: `summary-flow.js`

> Quy tắc nhanh: nếu là 1 flow độc lập thì phải có file JS độc lập.

### 2) Không gộp dồn tất cả vào `script.js`
- `script.js` (nếu còn dùng) chỉ nên làm nhiệm vụ khởi tạo hoặc điều phối nhẹ.
- Mọi logic chính phải nằm trong các module tương ứng.

### 3) Tách rõ trách nhiệm
- File nào xử lý flow nào thì chỉ chứa logic của flow đó.
- Hàm dùng chung tách vào file `utils` riêng.
- Không import vòng tròn, không phụ thuộc chéo khó kiểm soát.

---

## Cấu trúc gợi ý

```text
KS Mobile/
├─ index.html
├─ style.css
├─ js/
│  ├─ core/
│  │  ├─ app-init.js
│  │  └─ router.js
│  ├─ flows/
│  │  ├─ login-flow.js
│  │  ├─ survey-flow.js
│  │  ├─ upload-flow.js
│  │  └─ summary-flow.js
│  └─ shared/
│     ├─ api-client.js
│     ├─ validators.js
│     └─ dom-utils.js
└─ README.md
```

---

## Quy ước phát triển
- Đặt tên file theo chức năng/flow, dễ đọc và thống nhất hậu tố `-flow.js` cho flow.
- Mỗi module nên có phạm vi rõ ràng, không vượt quá trách nhiệm chính.
- Khi thêm tính năng mới, ưu tiên tạo module mới thay vì nhồi thêm vào file cũ.
- Code review cần kiểm tra tiêu chí: **“1 flow = 1 JS”** trước khi merge.

---

## Checklist trước khi commit
- [ ] Tính năng mới đã tách thành module riêng chưa?
- [ ] Có logic nào bị nhét vào file tổng không?
- [ ] Có hàm dùng chung nào cần đưa về `shared/` không?
- [ ] Có phụ thuộc chéo gây khó test/debug không?

---

## Ghi chú cho team
Nếu cần làm nhanh (hotfix), vẫn phải giữ nguyên tắc tách flow. Có thể làm bản đơn giản trước, nhưng **không phá kiến trúc module**.

## Security & Ownership: Request visibility

### Mô tả vấn đề
- Hiện tại hệ thống lưu `request.requester = JSON.stringify(currentSession)` khi tạo yêu cầu. Các màn hình danh sách (`renderRequestList`, `updateRequestCount`, `updateHomeStats`) lọc `allRequests` theo `request.requester` so khớp với `currentSession`, vì vậy **về mặt UI chỉ người tạo mới thấy các yêu cầu của mình**.
- Tuy nhiên, các hàm hiển thị chi tiết như `showRequestDetail(id)` và `viewDesign(id)` không thực hiện kiểm tra quyền sở hữu trên `id` trước khi hiển thị. Nếu ai đó biết `__backendId` của yêu cầu khác, họ có thể gọi trực tiếp hàm đó trên console và xem dữ liệu.

### Rủi ro
- Lỗ hổng này làm giảm tính bảo mật: client hiện chỉ dựa vào lọc hiển thị (client-side) thay vì enforcement kỹ thuật.
- Nếu backend/SDK (`window.dataSdk`) được bật và client tải về `allRequests` lớn, cần đảm bảo server chỉ trả dữ liệu mà user được phép xem.

### Khuyến nghị (ưu tiên)
1. Thêm kiểm tra ownership ngay trong `showRequestDetail(id)` và `viewDesign(id)`:
   - Sau khi lấy request theo `__backendId`, parse `request.requester` và kiểm tra so khớp với `currentSession` (theo `saleCode` hoặc `phone`). Nếu không khớp, hiển thị `showToast('Không có quyền xem yêu cầu này')` và return.
2. Bảo đảm server-side enforcement khi sử dụng `dataSdk`: server chỉ trả các yêu cầu thuộc user hoặc endpoint thực hiện check quyền trước khi trả về.
3. Hiển thị thông báo (toast) khi autofill từ yêu cầu cũ xảy ra để tránh user bị bất ngờ khi form bị điền tự động.
4. Thêm unit tests cho `checkOutletDuplicate`, `areItemsEquivalent` và guard ownership để tránh regressions.

### Vị trí thay đổi gợi ý
- `js/flows/request-flow.js` — `checkOutletDuplicate`, `submitNewRequest`, `viewLastCreatedRequest`.
- `js/flows/detail-flow.js` — thêm ownership guard ở `showRequestDetail` và `viewDesign`.
- `js/flows/list-flow.js` — đã có lọc, giữ nguyên.

Thực hiện các bước trên sẽ giúp phần hiển thị và bảo mật dữ liệu yêu cầu vững chắc hơn.

## Security & Ownership: Request visibility

### Mô tả vấn đề
- Hiện tại hệ thống lưu `request.requester = JSON.stringify(currentSession)` khi tạo yêu cầu. Các màn hình danh sách (`renderRequestList`, `updateRequestCount`, `updateHomeStats`) lọc `allRequests` theo `request.requester` so khớp với `currentSession`, vì vậy **về mặt UI chỉ người tạo mới thấy các yêu cầu của mình**.
- Tuy nhiên, các hàm hiển thị chi tiết như `showRequestDetail(id)` và `viewDesign(id)` không thực hiện kiểm tra quyền sở hữu trên `id` trước khi hiển thị. Nếu ai đó biết `__backendId` của yêu cầu khác, họ có thể gọi trực tiếp hàm đó trên console và xem dữ liệu.

### Rủi ro
- Lỗ hổng này làm giảm tính bảo mật: client hiện chỉ dựa vào lọc hiển thị (client-side) thay vì enforcement kỹ thuật.
- Nếu backend/SDK (`window.dataSdk`) được bật và client tải về `allRequests` lớn, cần đảm bảo server chỉ trả dữ liệu mà user được phép xem.

### Khuyến nghị (ưu tiên)
1. Thêm kiểm tra ownership ngay trong `showRequestDetail(id)` và `viewDesign(id)`:
   - Sau khi lấy request theo `__backendId`, parse `request.requester` và kiểm tra so khớp với `currentSession` (theo `saleCode` hoặc `phone`). Nếu không khớp, hiển thị `showToast('Không có quyền xem yêu cầu này')` và return.
2. Bảo đảm server-side enforcement khi sử dụng `dataSdk`: server chỉ trả các yêu cầu thuộc user hoặc endpoint thực hiện check quyền trước khi trả về.
3. Hiển thị thông báo (toast) khi autofill từ yêu cầu cũ xảy ra để tránh user bị bất ngờ khi form bị điền tự động.
4. Thêm unit tests cho `checkOutletDuplicate`, `areItemsEquivalent` và guard ownership để tránh regressions.

### Vị trí thay đổi gợi ý
- `js/flows/request-flow.js` — `checkOutletDuplicate`, `submitNewRequest`, `viewLastCreatedRequest`.
- `js/flows/detail-flow.js` — thêm ownership guard ở `showRequestDetail` và `viewDesign`.
- `js/flows/list-flow.js` — đã có lọc, giữ nguyên.

Thực hiện các bước trên sẽ giúp phần hiển thị và bảo mật dữ liệu yêu cầu vững chắc hơn.

## Security & Ownership: Request visibility

### Mô tả vấn đề
- Hiện tại hệ thống lưu 
equest.requester = JSON.stringify(currentSession) khi tạo yêu cầu. Các màn hình danh sách (
enderRequestList, updateRequestCount, updateHomeStats) lọc llRequests theo 
equest.requester so khớp với currentSession, vì vậy **về mặt UI chỉ người tạo mới thấy các yêu cầu của mình**.
- Tuy nhiên, các hàm hiển thị chi tiết như showRequestDetail(id) và iewDesign(id) không thực hiện kiểm tra quyền sở hữu trên id trước khi hiển thị. Nếu ai đó biết __backendId của yêu cầu khác, họ có thể gọi trực tiếp hàm đó trên console và xem dữ liệu.

### Rủi ro
- Lỗ hổng này làm giảm tính bảo mật: client hiện chỉ dựa vào lọc hiển thị (client-side) thay vì enforcement kỹ thuật.
- Nếu backend/SDK (window.dataSdk) được bật và client tải về llRequests lớn, cần đảm bảo server chỉ trả dữ liệu mà user được phép xem.

### Khuyến nghị (ưu tiên)
1. Thêm kiểm tra ownership ngay trong showRequestDetail(id) và iewDesign(id):
   - Sau khi lấy request theo __backendId, parse 
equest.requester và kiểm tra so khớp với currentSession (theo saleCode hoặc phone). Nếu không khớp, hiển thị showToast('Không có quyền xem yêu cầu này') và return.
2. Bảo đảm server-side enforcement khi sử dụng dataSdk: server chỉ trả các yêu cầu thuộc user hoặc endpoint thực hiện check quyền trước khi trả về.
3. Hiển thị thông báo (toast) khi autofill từ yêu cầu cũ xảy ra để tránh user bị bất ngờ khi form bị điền tự động.
4. Thêm unit tests cho checkOutletDuplicate, reItemsEquivalent và guard ownership để tránh regressions.

### Vị trí thay đổi gợi ý
- js/flows/request-flow.js — checkOutletDuplicate, submitNewRequest, iewLastCreatedRequest.
- js/flows/detail-flow.js — thêm ownership guard ở showRequestDetail và iewDesign.
- js/flows/list-flow.js — đã có lọc, giữ nguyên.

Thực hiện các bước trên sẽ giúp phần hiển thị và bảo mật dữ liệu yêu cầu vững chắc hơn.
