# ==========================================
# BƯỚC 5: DEPLOY BACKEND LÊN CLOUD RUN
# 
# Cấu hình Cloud Run rẻ nhất:
#   - Memory      : 256MB
#   - CPU         : 1 (chỉ allocate khi xử lý request)
#   - Min instances: 0 (scale to zero = FREE khi không dùng)
#   - Max instances: 2
#   - Region      : asia-southeast1
#
# Chi phí ước tính: ~$0-5/tháng (tùy traffic)
# ==========================================

$NEW_PROJECT  = "project-e466a86f-15b8-41c1-81a"
$REGION       = "asia-southeast1"
$SERVICE_NAME = "qcag-backend"
$IMAGE_NAME   = "gcr.io/$NEW_PROJECT/$SERVICE_NAME"
$SA_EMAIL     = "qcag-backend-sa@$NEW_PROJECT.iam.gserviceaccount.com"
$SQL_INSTANCE = "qcag-db"
$CONN_NAME    = "$NEW_PROJECT`:asia-southeast1:$SQL_INSTANCE"
$BUCKET_NAME  = "$NEW_PROJECT-qcag-images"

# !! ĐIỀN CÁC GIÁ TRỊ NÀY !!
$DB_PASSWORD  = Read-Host "Nhập DB_PASSWORD (mật khẩu database)" -AsSecureString
$DB_PASS_PLAIN = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($DB_PASSWORD))

$AUTH_SECRET  = Read-Host "Nhập AUTH_SECRET (chuỗi ngẫu nhiên >= 32 ký tự)" -AsSecureString
$AUTH_SECRET_PLAIN = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($AUTH_SECRET))

$GEMINI_KEY   = Read-Host "Nhập GEMINI_API_KEY (Enter để bỏ qua)"

Write-Host ""
Write-Host "=== DEPLOY CLOUD RUN ===" -ForegroundColor Cyan
Write-Host "Project : $NEW_PROJECT"
Write-Host "Service : $SERVICE_NAME"
Write-Host "Region  : $REGION"
Write-Host "Memory  : 256Mi (rẻ nhất)"
Write-Host "Min inst: 0 (scale to zero)"
Write-Host ""

# Chuyển sang project MỚI
gcloud config set project $NEW_PROJECT

# 1. Build và push Docker image
Write-Host "[1/3] Build & push Docker image..." -ForegroundColor Yellow

# Đặt working directory là backend-qcag-app
Push-Location "$PSScriptRoot\.."

gcloud builds submit . `
    --project=$NEW_PROJECT `
    --tag=$IMAGE_NAME `
    --region=$REGION

if ($LASTEXITCODE -ne 0) {
    Write-Host "THẤT BẠI khi build image" -ForegroundColor Red
    Pop-Location
    exit 1
}
Write-Host "OK - Image build và push xong" -ForegroundColor Green
Pop-Location

# 2. Lưu secrets vào Secret Manager (an toàn hơn env vars)
Write-Host ""
Write-Host "[2/3] Tạo secrets trong Secret Manager..." -ForegroundColor Yellow

function Set-GcpSecret {
    param($name, $value)
    $existing = gcloud secrets describe $name --project=$NEW_PROJECT 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  Cập nhật secret: $name"
        echo $value | gcloud secrets versions add $name --data-file=- --project=$NEW_PROJECT
    } else {
        Write-Host "  Tạo mới secret  : $name"
        echo $value | gcloud secrets create $name --data-file=- --project=$NEW_PROJECT --replication-policy=user-managed --locations=$REGION
    }
}

Set-GcpSecret "qcag-db-password" $DB_PASS_PLAIN
Set-GcpSecret "qcag-auth-secret" $AUTH_SECRET_PLAIN
if ($GEMINI_KEY) { Set-GcpSecret "qcag-gemini-key" $GEMINI_KEY }

# Cấp quyền đọc secrets cho Service Account
gcloud secrets add-iam-policy-binding qcag-db-password `
    --member="serviceAccount:$SA_EMAIL" `
    --role="roles/secretmanager.secretAccessor" `
    --project=$NEW_PROJECT 2>&1 | Out-Null

gcloud secrets add-iam-policy-binding qcag-auth-secret `
    --member="serviceAccount:$SA_EMAIL" `
    --role="roles/secretmanager.secretAccessor" `
    --project=$NEW_PROJECT 2>&1 | Out-Null

Write-Host "OK - Secrets đã lưu" -ForegroundColor Green

# 3. Deploy lên Cloud Run
Write-Host ""
Write-Host "[3/3] Deploy lên Cloud Run (rẻ nhất)..." -ForegroundColor Yellow

$deployArgs = @(
    "run", "deploy", $SERVICE_NAME,
    "--image=$IMAGE_NAME",
    "--project=$NEW_PROJECT",
    "--region=$REGION",
    "--platform=managed",
    "--service-account=$SA_EMAIL",
    "--memory=256Mi",
    "--cpu=1",
    "--min-instances=0",
    "--max-instances=2",
    "--concurrency=80",
    "--timeout=60s",
    "--add-cloudsql-instances=$CONN_NAME",
    "--allow-unauthenticated",
    "--set-env-vars=NODE_ENV=production,TZ=Asia/Ho_Chi_Minh,DB_USER=qcag,DB_NAME=qcag,GCS_BUCKET=$BUCKET_NAME,CLOUD_SQL_CONNECTION_NAME=$CONN_NAME",
    "--set-secrets=DB_PASSWORD=qcag-db-password:latest,AUTH_SECRET=qcag-auth-secret:latest"
)

if ($GEMINI_KEY) {
    $deployArgs += "--update-secrets=GEMINI_API_KEY=qcag-gemini-key:latest"
}

& gcloud @deployArgs

if ($LASTEXITCODE -ne 0) {
    Write-Host "THẤT BẠI khi deploy" -ForegroundColor Red
    exit 1
}

# Lấy URL service
$SERVICE_URL = gcloud run services describe $SERVICE_NAME `
    --project=$NEW_PROJECT `
    --region=$REGION `
    --format="value(status.url)" 2>&1

Write-Host ""
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "DEPLOY XONG!" -ForegroundColor Green
Write-Host "  URL Backend mới : $SERVICE_URL"
Write-Host "  Health check    : $SERVICE_URL/db-health"
Write-Host ""
Write-Host "Test bằng lệnh:" -ForegroundColor Yellow
Write-Host "  curl $SERVICE_URL/db-health"
Write-Host ""
Write-Host "Xem logs:" -ForegroundColor Yellow
Write-Host "  gcloud run services logs read $SERVICE_NAME --project=$NEW_PROJECT --region=$REGION"
Write-Host "===========================================" -ForegroundColor Cyan
