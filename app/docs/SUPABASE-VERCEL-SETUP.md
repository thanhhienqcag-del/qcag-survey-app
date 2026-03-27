# Supabase + Vercel — Setup, Deploy & Domain Guide

This document summarizes everything needed to work with the project's Supabase backend and to deploy the web app to Vercel. Copy this file to another machine and follow the steps below to reproduce the environment, deploy, and manage the production domain.

---

## 1. Overview

- Repository root: open this project folder and you'll find `server.js`, `_sdk/`, `js/`, `index.html`, helper PowerShell scripts like `start-localhost3000.ps1` and `start-localhost3001.ps1`.
- Local dev servers:
  - HTTPS servers run on ports `3000` and `3001` (self-signed). The app also runs an HTTP fallback on port `3002`.
  - Use `start-localhost3000.ps1 -Action start` to start the app (it opens HTTPS 3000 and HTTP 3002). For LAN testing, open `http://<LAN_IP>:3002` on your phone.

---

## 2. Supabase — project setup

Recommended: use the Supabase Dashboard (https://app.supabase.com) for initial setup.

1. Create a Supabase project (if not already created).
   - Choose a project name and database password. Note the project `URL` and `anon` key (API Key). Keep the service_role key private.

2. Database schema
   - Run the SQL migration file in this repo: `supabase-init.sql` (root or in repo docs). To execute:
     - Open Supabase Dashboard → Database → SQL Editor → New query → paste contents of `supabase-init.sql` and run.
     - Or use `psql`/supabase CLI if you prefer.

3. Storage buckets (if used)
   - In Supabase Dashboard → Storage → Create a bucket (e.g., `public-uploads`) and configure public/private access according to requirements.
   - Update RLS/policies to allow the web app to upload if necessary (or use signed uploads via server).

4. API keys and environment variables
   - You will need to store these values in your deployment environment (Vercel) as environment variables:
     - `SUPABASE_URL` — your Supabase project URL (example: `https://xyzcompany.supabase.co`)
     - `SUPABASE_ANON_KEY` — the anon/public API key for client-side usage
     - `SUPABASE_SERVICE_ROLE_KEY` — service role key (only on server-side; do NOT expose in client builds)

5. Security notes
   - NEVER commit `service_role` keys to source control.
   - Replace any hard-coded keys in `_sdk/supabase.js` with environment variable usage (see Section 6).

---

## 3. Vercel — project setup & environment

1. Create / connect a Vercel project
   - Sign in to https://vercel.com and create a new project. Link it to the repository (GitHub/GitLab/Bitbucket or push via Vercel CLI).

2. Environment variables (Vercel dashboard)
   - Go to Project → Settings → Environment Variables and set the following (for each of `Production`, `Preview`, and `Development` as appropriate):
     - `SUPABASE_URL` = your Supabase URL
     - `SUPABASE_ANON_KEY` = your Supabase anon key
     - `SUPABASE_SERVICE_ROLE_KEY` = (only for server-side usage) — set this as `Encrypted` and never expose to client
     - Any other keys used by your project (e.g., `VERCEL_TOKEN` if using CLI automation)

3. Build & Output
   - This project is a static SPA with a small Node Express server for local testing. When deploying to Vercel you can:
     - Deploy the static site only (point Vercel to serve `index.html` and static assets). Use Vercel static build settings.
     - Or deploy via a serverless function / Node server (advanced). For simplicity, prefer a static export when possible.

4. Custom domain
   - In Vercel Dashboard → Domains → Add Domain. Follow instructions to add DNS records at your registrar.
   - Assign the domain to the project (Production environment) and wait for certificate issuance (Vercel will provide a trusted TLS cert automatically).

5. Deployment via CLI (quick)
   - Install the Vercel CLI and log in:
     ```bash
     npm i -g vercel
     vercel login
     ```
   - From the project root run a production deploy:
     ```bash
     vercel --prod --confirm
     ```
   - To deploy a preview (development) build:
     ```bash
     vercel
     ```

6. Logs & troubleshooting
   - Vercel → Project → Deployments → select a deployment → View Functions/Logs for errors.

---

## 4. Local development & testing

1. Start local server (uses self-signed cert for https)
   - On Windows (PowerShell) from project root:
     ```powershell
     .\start-localhost3000.ps1 -Action start
     ```
   - This attempts to open `https://localhost:3000` (self-signed) and `http://localhost:3002` (HTTP fallback). If your phone cannot accept the self-signed certificate, use `http://<LAN_IP>:3002`.

2. LAN testing from phone
   - Determine your host machine LAN IP (e.g., `192.168.1.167`). On the host run:
     ```powershell
     ipconfig
     ```
   - On phone (same Wi‑Fi) open:
     - `http://<LAN_IP>:3002` — recommended (no TLS issues)
     - `https://<LAN_IP>:3000` — requires trusting the self-signed cert on the phone (not recommended)

3. Smoke checks
   - Health endpoint: `GET /sync` → should return `{ ok: true, ts: <timestamp> }`.
   - Data endpoint: `GET /data` → shows local `data.json` or Supabase-backed data if configured.

---

## 5. Replace hard-coded Supabase keys (recommended)

If `_sdk/supabase.js` currently contains keys in source, update it to read environment variables instead. Example pattern:

```js
// _sdk/supabase.js (example)
const SUPABASE_URL = process.env.SUPABASE_URL || '<fallback-url-if-any>';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '<fallback-anon-key>';
// Use these when creating client
// const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
```

On Vercel, set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in Project → Settings → Environment Variables so builds and serverless functions pick them up.

Note: If you are running purely static client code, environment variables must be injected at build time (or serve keys via edge functions). For runtime server code use server environment variables.

---

## 6. Running migrations & SQL

1. Use the Supabase SQL Editor (Dashboard) to run `supabase-init.sql`.
2. If you prefer CLI automation, install the Supabase CLI and use it to run migrations (see Supabase docs). Example:
   ```bash
   npm i -g supabase
   supabase login
   supabase db remote set <connection-string>
   # Then run SQL scripts via psql or via the dashboard
   ```

---

## 7. Testing after deploy (quick checklist)

- Visit the production domain (you configured on Vercel) — TLS should be trusted.
- Call `https://<your-domain>/sync` to confirm the app server responds.
- Test Supabase connectivity by exercising features that create/read data.

---

## 8. Troubleshooting

- If the app works locally on `localhost` but fails when accessed by phone over LAN:
  - Check Windows Firewall allows inbound TCP 3002 (HTTP) or 3000/3001 (HTTPS).
  - Ensure the server is listening on `0.0.0.0` (not `127.0.0.1`). The project intentionally binds `0.0.0.0`.
- If Supabase calls fail with 401/403:
  - Confirm `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set correctly in Vercel env vars.
  - Check RLS policies on Supabase tables.
- If app is served over HTTPS in production but calls to Supabase fail (CORS):
  - Ensure Supabase project allows the production origin via its CORS / API settings.

---

## 9. Useful commands reference

Local server start:
```powershell
.\start-localhost3000.ps1 -Action start
```
Vercel deploy (from project root):
```bash
vercel --prod --confirm
```
Check health endpoint:
```bash
curl https://<your-domain>/sync
```

---

## 10. Contacts & notes

- Repo maintainer: check `README.md` or ask the original author for keys if missing.
- Keep secrets out of source. Use encrypted environment variables in Vercel, and restrict Supabase service role keys to server-only usage.

---

If you'd like, I can also:
- Update `_sdk/supabase.js` to read `process.env.*` and add a short example for Vercel `vercel.json` or GitHub Actions.
- Create a small `README-DEPLOY.md` with screenshots for the Dashboard steps.
