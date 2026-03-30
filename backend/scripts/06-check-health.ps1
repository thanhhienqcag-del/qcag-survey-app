# ==========================================
# TIỆN ÍCH: Kiểm tra Health & Logs
# ==========================================

$NEW_PROJECT  = "project-e466a86f-15b8-41c1-81a"
$REGION       = "asia-southeast1"
$SERVICE_NAME = "qcag-backend"

Write-Host "=== KIỂM TRA BACKEND MỚI ===" -ForegroundColor Cyan

# Lấy URL
$SERVICE_URL = gcloud run services describe $SERVICE_NAME `
    --project=$NEW_PROJECT `
    --region=$REGION `
    --format="value(status.url)" 2>&1

Write-Host "URL: $SERVICE_URL"
Write-Host ""

# Health check
Write-Host "[1] DB Health check..." -ForegroundColor Yellow
try {
    $resp = Invoke-RestMethod -Uri "$SERVICE_URL/db-health" -TimeoutSec 30
    Write-Host "  DB OK: $($resp | ConvertTo-Json -Compress)" -ForegroundColor Green
} catch {
    Write-Host "  LỖI: $_" -ForegroundColor Red
}

# Cloud SQL status
Write-Host ""
Write-Host "[2] Cloud SQL status..." -ForegroundColor Yellow
gcloud sql instances describe qcag-db --project=$NEW_PROJECT --format="value(state,ipAddresses[0].ipAddress)" 2>&1

# Cloud Run status
Write-Host ""
Write-Host "[3] Cloud Run service..." -ForegroundColor Yellow
gcloud run services describe $SERVICE_NAME `
    --project=$NEW_PROJECT `
    --region=$REGION `
    --format="table(status.url,status.conditions[0].type,status.conditions[0].status)" 2>&1

# Xem logs gần nhất (50 dòng)
Write-Host ""
Write-Host "[4] Logs gần nhất..." -ForegroundColor Yellow
gcloud run services logs read $SERVICE_NAME `
    --project=$NEW_PROJECT `
    --region=$REGION `
    --limit=50 2>&1
