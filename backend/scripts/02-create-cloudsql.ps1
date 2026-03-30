# ==========================================
# BƯỚC 2: TẠO CLOUD SQL (RẺ NHẤT)
# 
# Cấu hình được chọn:
#   - Tier    : db-f1-micro (shared CPU, 0.6GB RAM)
#   - Storage : HDD 10GB (rẻ hơn SSD ~60%)
#   - Region  : asia-southeast1 (Singapore)
#   - HA      : KHÔNG (single zone)
#   - Backup  : 1 backup/ngày (tối thiểu)
#
# Chi phí ước tính: ~$9-12/tháng
# KHÔNG đụng project cũ: qcag-483014
# ==========================================

$NEW_PROJECT  = "project-e466a86f-15b8-41c1-81a"
$REGION       = "asia-southeast1"
$ZONE         = "asia-southeast1-a"
$INSTANCE     = "qcag-db"
$DB_NAME      = "qcag"
$DB_USER      = "qcag"

# !! THAY ĐỔI MẬT KHẨU NÀY TRƯỚC KHI CHẠY !!
$DB_PASSWORD  = Read-Host "Nhập mật khẩu mới cho database" -AsSecureString
$DB_PASS_PLAIN = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($DB_PASSWORD))

Write-Host ""
Write-Host "=== TẠO CLOUD SQL INSTANCE ===" -ForegroundColor Cyan
Write-Host "Project  : $NEW_PROJECT"
Write-Host "Instance : $INSTANCE"
Write-Host "Tier     : db-f1-micro (rẻ nhất)"
Write-Host "Storage  : HDD 10GB"
Write-Host "Region   : $REGION"
Write-Host ""

# Xác nhận trước khi chạy
$confirm = Read-Host "Tạo Cloud SQL? (yes/no)"
if ($confirm -ne "yes") { Write-Host "Đã hủy." -ForegroundColor Red; exit }

# Tạo Cloud SQL instance (mất 5-10 phút)
Write-Host "[1/4] Tạo Cloud SQL instance (mất 5-10 phút)..." -ForegroundColor Yellow
gcloud sql instances create $INSTANCE `
    --project=$NEW_PROJECT `
    --database-version=MYSQL_8_0 `
    --tier=db-f1-micro `
    --region=$REGION `
    --storage-type=HDD `
    --storage-size=10GB `
    --no-storage-auto-increase `
    --no-backup `
    --availability-type=zonal `
    --no-assign-ip `
    --network=default `
    --deletion-protection

# Nếu muốn dùng IP public (không cần VPC), thay --no-assign-ip bằng:
# --assign-ip

if ($LASTEXITCODE -ne 0) {
    Write-Host "THẤT BẠI khi tạo instance. Thử lại với IP public..." -ForegroundColor Yellow
    gcloud sql instances create $INSTANCE `
        --project=$NEW_PROJECT `
        --database-version=MYSQL_8_0 `
        --tier=db-f1-micro `
        --region=$REGION `
        --storage-type=HDD `
        --storage-size=10GB `
        --no-storage-auto-increase `
        --no-backup `
        --availability-type=zonal `
        --deletion-protection
}

Write-Host "OK - Instance tạo xong" -ForegroundColor Green

# Tạo database
Write-Host ""
Write-Host "[2/4] Tạo database '$DB_NAME'..." -ForegroundColor Yellow
gcloud sql databases create $DB_NAME `
    --instance=$INSTANCE `
    --project=$NEW_PROJECT `
    --charset=utf8mb4 `
    --collation=utf8mb4_unicode_ci
Write-Host "OK - Database '$DB_NAME' tạo xong" -ForegroundColor Green

# Tạo user
Write-Host ""
Write-Host "[3/4] Tạo user '$DB_USER'..." -ForegroundColor Yellow
gcloud sql users create $DB_USER `
    --instance=$INSTANCE `
    --project=$NEW_PROJECT `
    --password=$DB_PASS_PLAIN
Write-Host "OK - User '$DB_USER' tạo xong" -ForegroundColor Green

# Xóa user root mặc định (bảo mật)
gcloud sql users delete root `
    --instance=$INSTANCE `
    --project=$NEW_PROJECT `
    --host=% 2>&1 | Out-Null

# Lấy connection name
$CONNECTION_NAME = "$NEW_PROJECT`:asia-southeast1:$INSTANCE"

Write-Host ""
Write-Host "[4/4] Lấy thông tin kết nối..." -ForegroundColor Yellow
$SQL_IP = gcloud sql instances describe $INSTANCE `
    --project=$NEW_PROJECT `
    --format="value(ipAddresses[0].ipAddress)" 2>&1

Write-Host ""
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "CLOUD SQL TẠO XONG!" -ForegroundColor Green
Write-Host "  Instance       : $INSTANCE"
Write-Host "  Connection name: $CONNECTION_NAME"
Write-Host "  Public IP      : $SQL_IP"
Write-Host "  DB Name        : $DB_NAME"
Write-Host "  DB User        : $DB_USER"
Write-Host ""
Write-Host "Cập nhật vào .env file:" -ForegroundColor Yellow
Write-Host "  CLOUD_SQL_CONNECTION_NAME=$CONNECTION_NAME"
Write-Host "  DB_USER=$DB_USER"
Write-Host "  DB_NAME=$DB_NAME"
Write-Host "  DB_PASSWORD=<mật khẩu bạn vừa nhập>"
Write-Host ""
Write-Host "BƯỚC TIẾP THEO: Chạy 03-migrate-db.ps1" -ForegroundColor Yellow
Write-Host "===========================================" -ForegroundColor Cyan
