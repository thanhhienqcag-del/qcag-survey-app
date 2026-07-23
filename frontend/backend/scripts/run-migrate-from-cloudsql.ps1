# scripts/run-migrate-from-cloudsql.ps1
#
# Chạy toàn bộ quy trình: xác thực gcloud, lấy thông tin instance,
# khởi động Cloud SQL Auth Proxy, và chạy migration sang Neon.
#
# Yêu cầu:
#   - gcloud đã đăng nhập (gcloud auth login)
#   - node + npm đã cài
#   - Cloud SQL Auth Proxy (tải tự động nếu chưa có)

Set-StrictMode -Off
$ErrorActionPreference = "Stop"

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host " QCAG Cloud SQL -> Neon Migration Tool" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

$BackendDir = Split-Path -Parent $PSScriptRoot

# ── Bước 1: Kiểm tra gcloud auth ─────────────────────────────────────
Write-Host "[1/5] Checking gcloud authentication..." -ForegroundColor Yellow
$authCheck = gcloud auth list --filter="status:ACTIVE" --format="value(account)" 2>&1
if (!$authCheck) {
    Write-Host "   ⚠️  Not logged in. Running gcloud auth login..." -ForegroundColor Red
    gcloud auth login
    $authCheck = gcloud auth list --filter="status:ACTIVE" --format="value(account)" 2>&1
}
Write-Host "   ✅ Logged in as: $authCheck" -ForegroundColor Green

# ── Bước 2: Lấy thông tin Cloud SQL instance ─────────────────────────
Write-Host "`n[2/5] Listing Cloud SQL instances in project qcag-483014..." -ForegroundColor Yellow
gcloud config set project qcag-483014 2>&1 | Out-Null
$instances = gcloud sql instances list --format="value(name,connectionName,ipAddresses[0].ipAddress)" 2>&1
Write-Host $instances

# Lấy connection name của instance đầu tiên
$connectionName = gcloud sql instances list --format="value(connectionName)" 2>&1 | Select-Object -First 1
$connectionName = $connectionName.Trim()

if (!$connectionName) {
    Write-Host "   ❌ Could not find Cloud SQL instance!" -ForegroundColor Red
    exit 1
}
Write-Host "   ✅ Connection name: $connectionName" -ForegroundColor Green

# ── Bước 3: Tải Cloud SQL Auth Proxy nếu chưa có ─────────────────────
Write-Host "`n[3/5] Setting up Cloud SQL Auth Proxy..." -ForegroundColor Yellow
$proxyPath = Join-Path $PSScriptRoot "cloud-sql-proxy.exe"

if (!(Test-Path $proxyPath)) {
    Write-Host "   Downloading cloud-sql-proxy.exe..."
    $url = "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.14.1/cloud-sql-proxy.windows.amd64.exe"
    Invoke-WebRequest -Uri $url -OutFile $proxyPath
    Write-Host "   ✅ Downloaded" -ForegroundColor Green
} else {
    Write-Host "   ✅ Already exists: $proxyPath" -ForegroundColor Green
}

# ── Bước 4: Khởi động proxy (background) ─────────────────────────────
Write-Host "`n[4/5] Starting Cloud SQL Auth Proxy on 127.0.0.1:3306..." -ForegroundColor Yellow
$proxyJob = Start-Process -FilePath $proxyPath `
    -ArgumentList "$connectionName --port=3306" `
    -PassThru -WindowStyle Hidden

Write-Host "   ✅ Proxy PID: $($proxyJob.Id)" -ForegroundColor Green
Write-Host "   Waiting 3s for proxy to be ready..." -ForegroundColor Gray
Start-Sleep -Seconds 3

# ── Bước 5: Lấy password MySQL rồi chạy migration ────────────────────
Write-Host "`n[5/5] Running migration..." -ForegroundColor Yellow

# Đọc password từ .env.migrate
$envFile = Join-Path $PSScriptRoot ".env.migrate"
if (Test-Path $envFile) {
    Get-Content $envFile | Where-Object { $_ -match '^\s*\w' -and $_ -notmatch '^\s*#' } | ForEach-Object {
        $parts = $_ -split '=', 2
        if ($parts.Length -eq 2) {
            $key = $parts[0].Trim()
            $val = $parts[1].Trim()
            if ($val) {
                [System.Environment]::SetEnvironmentVariable($key, $val)
            }
        }
    }
}

# Nếu MYSQL_PASSWORD chưa có, hỏi người dùng
if (!$env:MYSQL_PASSWORD) {
    $pwd = Read-Host -Prompt "   Enter MySQL password for user '$($env:MYSQL_USER)'"
    $env:MYSQL_PASSWORD = $pwd
}

Write-Host ""
Push-Location $BackendDir
try {
    # Cài mysql2 nếu chưa có
    if (!(Test-Path (Join-Path $BackendDir "node_modules\mysql2"))) {
        Write-Host "   Installing mysql2..." -ForegroundColor Gray
        npm install mysql2 --no-save 2>&1 | Tail -5
    }

    # Chạy migration
    node scripts/migrate-from-cloudsql.js
} finally {
    Pop-Location
    # Dừng proxy
    if ($proxyJob -and !$proxyJob.HasExited) {
        Write-Host "`n   Stopping proxy (PID $($proxyJob.Id))..." -ForegroundColor Gray
        Stop-Process -Id $proxyJob.Id -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "`n✅ Done!" -ForegroundColor Green
