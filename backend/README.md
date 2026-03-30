# QCAG Backend API

Vercel Serverless API dùng chung cho **Survey App** và **Quote App**.

---

## **Access Keys & Where to Find Them (DO NOT STORE SECRETS HERE)**

- **Vercel (environment variables & project settings):**
  - Location: Vercel Dashboard → Select Project → `Settings` → `Environment Variables`.
  - What to look for: `VERCEL_URL`, any `NEXT_PUBLIC_*` public vars, and secret env vars used by the API (e.g. `DATABASE_URL`).
  - Note: Deployments also surface Logs and Function Invocations in `Deployments` and `Functions` tabs.

- **Neon (Postgres connection string):**
  - Location: Neon Console → Select Project → `Connection` or `Credentials` → `Connection string` / `URI`.
  - Use the **Admin** or **Primary** connection string (with search/rotate secrets only in Neon UI). Do NOT paste the full connection string into a public README — keep it in Vercel env or a `.env` file locally.

- **Image storage:**
  - Images are expected to be stored in Google Cloud Storage (GCS). Cloudinary integration has been removed from this repository; update upload helpers to use GCS if needed.

> Security reminder: This README contains only pointers. Never commit actual API keys or connection strings to the repository. Put secrets into Vercel Environment Variables or a protected secret manager and reference them via `process.env` or `DATABASE_URL`.

---

## **Migration notes — 2026-03-23**

Summary of today's work (what I did with the SQL dumps and database import):

- Downloaded MySQL dump files from GCS into `scripts/data/`:
  - `quotations.sql.gz` → decompressed to `quotations.sql` (51,228,240 bytes)
  - `pending_orders.sql.gz` → `pending_orders.sql` (164,180 bytes)
  - `production_orders.sql.gz` → `production_orders.sql` (2,325 bytes)
  - `quote_sequences.sql.gz` → `quote_sequences.sql` (2,041 bytes)
  - `users.sql.gz` → `users.sql` (3,471 bytes)
  - `inspections.sql.gz` → `inspections.sql` (2,027 bytes)

- Implemented a robust ETL importer in `scripts/import-sql-to-neon.js` to move data from MySQL dumps into the Neon PostgreSQL instance. Key points:
  - Replaced an initial regex-based parser with a stateful, character-scanning `extractInsertBlocks()` to correctly handle multi-row `INSERT` statements that contain JSON, escaped quotes, and semicolons inside values.
  - Added `extractRows()` and `parseMySQLRow()` to safely parse MySQL `VALUES (...)` rows into JavaScript values (handling `NULL`, numbers, and MySQL-escaped strings).
  - Built explicit column reorder mappings (`TABLE_MAPS`) to map MySQL dump column order to the Neon table column order for each imported table (notably `quotations` had differing ordering).
  - Added defaulting logic for Neon `NOT NULL` boolean-like columns (e.g., `is_confirmed`, `is_exported`, `approved`) when source contains `NULL`.
  - Insert behavior: parameterized `INSERT` with `ON CONFLICT DO NOTHING` and sequence reset after import.

- Supporting scripts added/used (in `scripts/`):
  - `check-cols.js` — extract column lists from MySQL `CREATE TABLE` in the dumps.
  - `check-neon-schema.js` — query Neon `information_schema` for actual table/column ordering.
  - `count-rows.js` / `count-rows2.js` — reliably count rows across multi-row `INSERT` blocks.
  - `verify-neon.js` — simple verification queries (row counts and sample rows) against Neon.
  - `check-first-row.js` — preview the first row format to confirm column counts.

- Import results (verified):
  - `quotations`: 1484 rows imported (previous partial import due to parsing bug fixed)
  - `users`: 6 rows
  - `quote_sequences`: 1 row
  - `production_orders`: 1 row
  - `pending_orders`: 1 row
  - `inspections`: 0 rows

- Important debugging notes & lessons:
  - Naive regex fails on complex dumps with embedded JSON / escaped semicolons — use a stateful parser.
  - Always check target DB schema column ordering — perform explicit column mapping before insert.
  - Anticipate `NOT NULL` constraints on target DB; provide sensible defaults during ETL.

---

## **How to re-run the import (commands)**

1. Place the `.sql` files into `scripts/data/` (already done in my run).
2. Install deps (if needed):

```bash
cd backend-qcag-app
npm install
```

3. Set `DATABASE_URL` (Neon) and `GCS_BUCKET` env vars locally or in Vercel. Example local `.env` (do NOT commit):

```
DATABASE_URL=postgresql://<user>:<pass>@<host>/<db>?sslmode=require
GCS_BUCKET=your-gcs-bucket-name
```

4. Run the importer (example):

```bash
cd backend-qcag-app/scripts
node import-sql-to-neon.js
node verify-neon.js   # quick verification counts
```

---

## **Files of interest**

- `scripts/import-sql-to-neon.js` — main importer (ETL parser + insert logic)
- `scripts/data/*.sql` — decompressed MySQL dumps
- `scripts/verify-neon.js` — post-import checks
- `db.js` — Neon pool config used by the API
- `.env.example` — sample env vars

---

If you want, I can:
- Add a `README_MIGRATION.md` with step-by-step commands and a dry-run mode for the importer.
- Replace any embedded connection strings in scripts with `process.env.DATABASE_URL` and add a `.env.local` example.

---
- **DB**: PostgreSQL (Neon)
- **Image storage**: Cloudinary (chỉ lưu URL trong DB)
- **Hosting**: Vercel Serverless Functions

---

## Cấu trúc thư mục

```
backend-qcag-app/
├── api/
│   ├── projects.js   GET / POST / PATCH  /api/projects
│   ├── surveys.js    GET / POST / PATCH  /api/surveys
│   ├── quotes.js     GET / POST / PATCH  /api/quotes
│   └── orders.js     GET / POST / PATCH  /api/orders
├── lib/
│   └── (cloudinary removed) upload helpers should be implemented using GCS
├── db.js             PostgreSQL Pool (Neon)
├── schema.sql        SQL tạo bảng (chạy 1 lần trên Neon console)
├── vercel.json       Cấu hình Vercel
├── package.json
└── .env.example      Mẫu biến môi trường
```

---

## Thiết lập lần đầu

### 1. Tạo database trên Neon
1. Đăng ký tại https://neon.tech
2. Tạo project mới → lấy Connection String
3. Mở SQL Editor → paste toàn bộ nội dung schema.sql và chạy

### 2. Tạo tài khoản Cloudinary
1. Đăng ký tại https://cloudinary.com
2. Vào Dashboard → lấy: Cloud Name, API Key, API Secret

### 3. Cài đặt
```bash
cp .env.example .env
# Điền DATABASE_URL, CLOUDINARY_* vào .env
npm install
npm run dev   # chạy local tại http://localhost:3101 (khuyến nghị)
```

### 3.1 Diagnose nhanh khi "khong ket noi duoc"
```bash
npm run diagnose:connectivity
```
Script se kiem tra:
- local backend health (`/api/ks/health`)
- cloud backend health
- parse `DATABASE_URL`
- DNS/TCP den DB host
- query `SELECT 1` vao Postgres

### 4. Deploy
```bash
npm run deploy
# Thêm env vars vào: Vercel Dashboard → Settings → Environment Variables
```

---

## Project Status Flow

```
pending → ready_for_quote → quoted → in_progress → done
```

| Sự kiện | Status mới |
|---------|-----------|
| Tạo project | pending |
| Survey App gửi survey | ready_for_quote |
| Quote App tạo quote | quoted |
| Tạo order | in_progress |
| Order completed | done |

---

## API nhanh

### POST /api/projects
```json
{ "name": "Bảng hiệu ABC", "customer": "Heineken", "outlet_code": "TK26.00001" }
```

### PATCH /api/projects – đổi status
```json
{ "id": 1, "status": "ready_for_quote" }
```

### POST /api/surveys – tạo survey + upload ảnh
```json
{
  "project_id": 1,
  "survey_data": { "width": 3.5, "height": 1.2 },
  "images": ["data:image/jpeg;base64,..."],
  "surveyed_by": "Nguyễn Văn A"
}
```

### POST /api/quotes
```json
{ "project_id": 1, "price": 5000000, "quoted_by": "QCAG Team" }
```

### POST /api/orders
```json
{ "project_id": 1, "quote_id": 1, "scheduled_at": "2026-04-01T08:00:00Z" }
```

### PATCH /api/orders – hoàn thành đơn hàng
```json
{ "id": 1, "status": "completed" }
```
