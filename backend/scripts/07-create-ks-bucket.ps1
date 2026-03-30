# ============================================================
# BƯỚC 7: TẠO GCS BUCKET CHO KS MOBILE ATTACHMENTS
#
# Bucket này hoàn toàn tách biệt với bucket QCAG Báo Giá
# ($PROJECT-qcag-images) để đảm bảo cách ly dữ liệu.
#
# Cấu hình:
#   - Location class : STANDARD (cân bằng chi phí/tốc độ)
#   - Region         : asia-southeast1 (Singapore)
#   - Access control : Uniform Bucket-Level Access (không dùng ACL legacy)
#   - Public access  : KHÔNG public — truy cập qua Signed URL
#
# Chi phí ước tính : ~$0.02/GB/tháng lưu trữ + $0.12/GB egress
# ============================================================

$PROJECT     = "project-e466a86f-15b8-41c1-81a"
$REGION      = "asia-southeast1"
$BUCKET_NAME = "$PROJECT-ks-attachments"   # << tách biệt với qcag-images
$SA_EMAIL    = "qcag-backend-sa@$PROJECT.iam.gserviceaccount.com"

Write-Host "=== TẠO GCS BUCKET KS MOBILE ===" -ForegroundColor Cyan
Write-Host "Project : $PROJECT"
Write-Host "Bucket  : $BUCKET_NAME"
Write-Host "Region  : $REGION"
Write-Host ""

# Xác nhận
$confirm = Read-Host "Tạo bucket '$BUCKET_NAME'? (yes/no)"
if ($confirm -ne "yes") { Write-Host "Đã hủy." -ForegroundColor Red; exit }

# 1. Tạo bucket với Uniform Access Control
Write-Host "[1/4] Tạo bucket..." -ForegroundColor Yellow
gcloud storage buckets create "gs://$BUCKET_NAME" `
    --project=$PROJECT `
    --location=$REGION `
    --uniform-bucket-level-access `
    --no-public-access-prevention

if ($LASTEXITCODE -ne 0) {
    Write-Host "THẤT BẠI khi tạo bucket" -ForegroundColor Red
    exit 1
}
Write-Host "OK - Bucket tạo xong" -ForegroundColor Green

# 2. Cấp quyền objectAdmin cho Service Account backend
Write-Host "[2/4] Cấp quyền objectAdmin cho SA..." -ForegroundColor Yellow
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET_NAME" `
    --member="serviceAccount:$SA_EMAIL" `
    --role="roles/storage.objectAdmin" `
    --project=$PROJECT

Write-Host "OK - SA có thể upload/delete ảnh KS Mobile" -ForegroundColor Green

# 3. CORS policy — cho phép browser upload trực tiếp (nếu dùng presigned URL)
Write-Host "[3/4] Đặt CORS policy..." -ForegroundColor Yellow
$corsJson = @'
[
  {
    "origin": ["*"],
    "method": ["GET", "PUT", "POST", "HEAD"],
    "responseHeader": ["Content-Type", "Content-MD5", "Authorization"],
    "maxAgeSeconds": 3600
  }
]
'@
$corsFile = "$env:TEMP\ks_cors.json"
$corsJson | Set-Content -Path $corsFile -Encoding UTF8
gcloud storage buckets update "gs://$BUCKET_NAME" `
    --cors-file=$corsFile `
    --project=$PROJECT
Remove-Item $corsFile -Force
Write-Host "OK - CORS đã được cấu hình" -ForegroundColor Green

# 4. Lifecycle policy: xóa objects chưa hoàn chỉnh (multipart) sau 7 ngày
Write-Host "[4/4] Đặt lifecycle policy..." -ForegroundColor Yellow
$lifecycleJson = @'
{
  "lifecycle": {
    "rule": [
      {
        "action": { "type": "AbortIncompleteMultipartUpload" },
        "condition": { "age": 7 }
      }
    ]
  }
}
'@
$lifecycleFile = "$env:TEMP\ks_lifecycle.json"
$lifecycleJson | Set-Content -Path $lifecycleFile -Encoding UTF8
gcloud storage buckets update "gs://$BUCKET_NAME" `
    --lifecycle-file=$lifecycleFile `
    --project=$PROJECT
Remove-Item $lifecycleFile -Force
Write-Host "OK - Lifecycle policy đã được cấu hình" -ForegroundColor Green

Write-Host ""
Write-Host "=== XONG ===" -ForegroundColor Green
Write-Host "Bucket KS Mobile: gs://$BUCKET_NAME" -ForegroundColor Cyan
Write-Host ""
Write-Host "Thêm vào Cloud Run environment variables:" -ForegroundColor Yellow
Write-Host "  KS_GCS_BUCKET=$BUCKET_NAME"
Write-Host ""
Write-Host "Lệnh cập nhật Cloud Run (ví dụ):"
Write-Host "  gcloud run services update qcag-backend \`"
Write-Host "    --update-env-vars KS_GCS_BUCKET=$BUCKET_NAME \`"
Write-Host "    --region=$REGION --project=$PROJECT"
