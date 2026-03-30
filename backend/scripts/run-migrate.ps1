# ==========================================
# run-migrate.ps1
# PowerShell wrapper để chạy migrate-supabase-to-mysql.js
# (DRY_RUN=true node ... không hợp lệ trong PowerShell)
#
# Cách dùng:
#   .\scripts\run-migrate.ps1            ← dry run (xem trước, không ghi dữ liệu)
#   .\scripts\run-migrate.ps1 -Live      ← thực sự migrate
#   .\scripts\run-migrate.ps1 -Images    ← migrate + re-upload ảnh lên GCS
# ==========================================
param(
    [switch]$Live,     # Bỏ chế độ dry run — ghi dữ liệu thực
    [switch]$Images    # Re-upload ảnh từ Supabase lên GCS KS bucket
)

# ── Cấu hình ──────────────────────────────────────────────────────────
# URL chính xác của Cloud Run — chỉ override nếu env được set rõ ràng
$DEFAULT_BACKEND = "https://qcag-backend-bgrkahehra-as.a.run.app"
$BACKEND_URL   = if ($env:KS_BACKEND_URL -and $env:KS_BACKEND_URL -ne "https://qcag-backend-979535713434.asia-southeast1.run.app") { $env:KS_BACKEND_URL } else { $DEFAULT_BACKEND }
$SUPABASE_URL  = if ($env:SUPABASE_URL)       { $env:SUPABASE_URL }       else { "https://kuflixiicocxhdwzfxct.supabase.co" }
$SUPABASE_KEY  = if ($env:SUPABASE_ANON_KEY)  { $env:SUPABASE_ANON_KEY }  else { "sb_publishable_HnObLflcqXh_8qjAFVjAaA_PV_eGJY7" }

# Đảm bảo env vars trong session dùng đúng URL
$env:KS_BACKEND_URL = $BACKEND_URL

# ── Chế độ chạy ───────────────────────────────────────────────────────
$env:KS_BACKEND_URL    = $BACKEND_URL
$env:SUPABASE_URL      = $SUPABASE_URL
$env:SUPABASE_ANON_KEY = $SUPABASE_KEY

if ($Live) {
    $env:DRY_RUN = "false"
    Write-Host "=== MIGRATE MODE: LIVE (ghi dữ liệu thực) ===" -ForegroundColor Red
} else {
    $env:DRY_RUN = "true"
    Write-Host "=== MIGRATE MODE: DRY RUN (chỉ xem trước) ===" -ForegroundColor Cyan
    Write-Host "  Dùng -Live để migrate thực sự"
}

if ($Images) {
    $env:MIGRATE_IMAGES = "true"
    Write-Host "  Chế độ ảnh: RE-UPLOAD → GCS" -ForegroundColor Yellow
} else {
    $env:MIGRATE_IMAGES = "false"
    Write-Host "  Chế độ ảnh: GIỮ URL SUPABASE (không re-upload)"
}

Write-Host ""
Write-Host "Backend URL : $BACKEND_URL"
Write-Host "Supabase URL: $SUPABASE_URL"
Write-Host ""

# ── Chạy migrate ──────────────────────────────────────────────────────
Set-Location $PSScriptRoot
node migrate-supabase-to-mysql.js
