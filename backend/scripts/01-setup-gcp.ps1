# ==========================================
# BƯỚC 1: SETUP GCP PROJECT MỚI
# Script này cấu hình GCP project mới với
# cấu hình RẺ NHẤT ở khu vực Đông Nam Á.
# 
# QUAN TRỌNG: Script này KHÔNG đụng project cũ
# ==========================================

$NEW_PROJECT = "project-e466a86f-15b8-41c1-81a"
$OLD_PROJECT = "qcag-483014"
$REGION      = "asia-southeast1"
$ZONE        = "asia-southeast1-a"

Write-Host "=== SETUP GCP PROJECT MỚI ===" -ForegroundColor Cyan
Write-Host "New Project: $NEW_PROJECT"
Write-Host "Region     : $REGION"
Write-Host ""

# 1. Đặt project đang làm việc là project MỚI
Write-Host "[1/5] Chuyển sang project MỚI..." -ForegroundColor Yellow
gcloud config set project $NEW_PROJECT
gcloud config set compute/region $REGION
gcloud config set compute/zone $ZONE
gcloud config set run/region $REGION
Write-Host "OK - Đang làm việc với project: $NEW_PROJECT" -ForegroundColor Green

# 2. Enable các APIs cần thiết (miễn phí)
Write-Host ""
Write-Host "[2/5] Bật APIs cần thiết..." -ForegroundColor Yellow
$apis = @(
    "run.googleapis.com",          # Cloud Run
    "sql-component.googleapis.com", # Cloud SQL
    "sqladmin.googleapis.com",     # Cloud SQL Admin
    "storage.googleapis.com",      # Google Cloud Storage
    "cloudbuild.googleapis.com",   # Cloud Build (deploy)
    "secretmanager.googleapis.com" # Secret Manager
)
foreach ($api in $apis) {
    Write-Host "  Enabling $api..."
    gcloud services enable $api --project=$NEW_PROJECT 2>&1 | Out-Null
}
Write-Host "OK - Tất cả APIs đã được bật" -ForegroundColor Green

# 3. Tạo Service Account cho backend
Write-Host ""
Write-Host "[3/5] Tạo Service Account..." -ForegroundColor Yellow
$SA_NAME = "qcag-backend-sa"
$SA_EMAIL = "$SA_NAME@$NEW_PROJECT.iam.gserviceaccount.com"

gcloud iam service-accounts create $SA_NAME `
    --display-name="QCAG Backend Service Account" `
    --project=$NEW_PROJECT 2>&1

# Cấp quyền cần thiết (tối thiểu)
gcloud projects add-iam-policy-binding $NEW_PROJECT `
    --member="serviceAccount:$SA_EMAIL" `
    --role="roles/cloudsql.client" 2>&1 | Out-Null

gcloud projects add-iam-policy-binding $NEW_PROJECT `
    --member="serviceAccount:$SA_EMAIL" `
    --role="roles/storage.objectAdmin" 2>&1 | Out-Null

Write-Host "OK - Service Account: $SA_EMAIL" -ForegroundColor Green

# 4. Tạo GCS Bucket (Standard, Regional - rẻ nhất)
Write-Host ""
Write-Host "[4/5] Tạo GCS Bucket (Standard Regional - rẻ nhất)..." -ForegroundColor Yellow
$BUCKET_NAME = "$NEW_PROJECT-qcag-images"

gcloud storage buckets create "gs://$BUCKET_NAME" `
    --project=$NEW_PROJECT `
    --location=$REGION `
    --uniform-bucket-level-access `
    --default-storage-class=STANDARD 2>&1

# Cấp quyền cho Service Account đọc/ghi bucket
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET_NAME" `
    --member="serviceAccount:$SA_EMAIL" `
    --role="roles/storage.objectAdmin" 2>&1 | Out-Null

Write-Host "OK - Bucket tạo xong: gs://$BUCKET_NAME" -ForegroundColor Green

# 5. Tóm tắt
Write-Host ""
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "SETUP XONG - Thông tin của project mới:" -ForegroundColor Green
Write-Host "  Project ID    : $NEW_PROJECT"
Write-Host "  Region        : $REGION"
Write-Host "  Service Acct  : $SA_EMAIL"
Write-Host "  GCS Bucket    : gs://$BUCKET_NAME"
Write-Host ""
Write-Host "BƯỚC TIẾP THEO: Chạy 02-create-cloudsql.ps1" -ForegroundColor Yellow
Write-Host "===========================================" -ForegroundColor Cyan
