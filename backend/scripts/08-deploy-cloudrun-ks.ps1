# ==========================================
# BƯỚC 8: CẬP NHẬT CLOUD RUN VỚI KS CONFIG
# Thêm biến môi trường KS_GCS_BUCKET vào service
# và deploy Docker image mới (nếu cần).
#
# Chạy sau khi:
#   - 07-create-ks-bucket.ps1  (bucket đã tồn tại)
#   - Đã build + push Docker image (hoặc dùng --source)
# ==========================================

$PROJECT  = "project-e466a86f-15b8-41c1-81a"
$REGION   = "asia-southeast1"
$SERVICE  = "qcag-backend"
$KS_BUCKET = "$PROJECT-ks-attachments"
$IMAGE    = "gcr.io/$PROJECT/$SERVICE"

Write-Host "=== DEPLOY CLOUD RUN + KS CONFIG ===" -ForegroundColor Cyan
Write-Host "Project   : $PROJECT"
Write-Host "Service   : $SERVICE"
Write-Host "Region    : $REGION"
Write-Host "KS Bucket : $KS_BUCKET"
Write-Host ""

# ── 1. Xác nhận bucket tồn tại ─────────────────────────────────────
Write-Host "[1/3] Kiểm tra KS bucket..." -ForegroundColor Yellow
$bucketExists = gcloud storage buckets describe "gs://$KS_BUCKET" --project=$PROJECT 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ⚠ Bucket gs://$KS_BUCKET chưa tồn tại." -ForegroundColor Red
    Write-Host "  Hãy chạy scripts\07-create-ks-bucket.ps1 trước."
    Write-Host "  Tiếp tục deploy vẫn ok, chỉ upload ảnh sẽ lỗi cho đến khi bucket được tạo."
} else {
    Write-Host "  ✓ Bucket gs://$KS_BUCKET tồn tại" -ForegroundColor Green
}

# ── 2. Build + Push Docker image ────────────────────────────────────
Write-Host ""
Write-Host "[2/3] Build và push Docker image..." -ForegroundColor Yellow
Write-Host "  (Dùng Cloud Build — không cần Docker local)"

$IMAGE = "gcr.io/$PROJECT/$SERVICE"
gcloud builds submit `
    --project=$PROJECT `
    --tag=$IMAGE `
    --ignore-file=.gcloudignore `
    "$(Split-Path $PSScriptRoot -Parent)"

if ($LASTEXITCODE -ne 0) {
    Write-Host "  ✗ Build thất bại. Kiểm tra lỗi phía trên." -ForegroundColor Red
    exit 1
}
Write-Host "  ✓ Image đã build và push thành công" -ForegroundColor Green

# ── 3. Deploy Cloud Run với env vars ────────────────────────────────
Write-Host ""
Write-Host "[3/3] Deploy Cloud Run..." -ForegroundColor Yellow

gcloud run deploy $SERVICE `
    --project=$PROJECT `
    --region=$REGION `
    --image=$IMAGE `
    --update-env-vars "KS_GCS_BUCKET=$KS_BUCKET" `
    --platform=managed `
    --allow-unauthenticated

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  ✗ Deploy thất bại." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "=== DEPLOY THÀNH CÔNG ===" -ForegroundColor Green
Write-Host "  KS_GCS_BUCKET = $KS_BUCKET đã được thêm vào Cloud Run"
Write-Host ""
Write-Host "Kiểm tra health:"
Write-Host "  gcloud run services describe $SERVICE --region=$REGION --project=$PROJECT --format='value(status.url)'"
Write-Host ""
Write-Host "Bước tiếp theo: chạy scripts\run-migrate.ps1 để import dữ liệu từ Supabase"
