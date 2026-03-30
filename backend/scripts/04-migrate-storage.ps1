# ==========================================
# BƯỚC 4: MIGRATE STORAGE (GCS IMAGES)
# 
# Copy ảnh từ bucket cũ sang bucket mới
# 
# QUAN TRỌNG:
#   - CHỈ COPY (không xóa gì ở bucket cũ)
#   - An toàn hoàn toàn với production
# ==========================================

$OLD_PROJECT  = "qcag-483014"
$NEW_PROJECT  = "project-e466a86f-15b8-41c1-81a"
$OLD_BUCKET   = "$OLD_PROJECT-qcag-images"
$NEW_BUCKET   = "$NEW_PROJECT-qcag-images"

Write-Host "=== MIGRATE STORAGE ===" -ForegroundColor Cyan
Write-Host "Source: gs://$OLD_BUCKET"
Write-Host "Target: gs://$NEW_BUCKET"
Write-Host ""
Write-Host "This will COPY only; the source bucket will not be modified." -ForegroundColor Green
Write-Host ""

# Kiểm tra số lượng files ở bucket cũ
Write-Host "[1/3] Kiểm tra dữ liệu ở bucket cũ..." -ForegroundColor Yellow
$fileCount = (gcloud storage ls "gs://$OLD_BUCKET/**" --project=$OLD_PROJECT 2>&1 | Measure-Object -Line).Lines
Write-Host "  Ước tính số files: $fileCount"

$confirm = Read-Host "Bắt đầu copy? (yes/no)"
if ($confirm -ne "yes") { Write-Host "Đã hủy." -ForegroundColor Red; exit }

Write-Host ""
Write-Host "[2/3] Copy toàn bộ files (có thể mất vài phút)..." -ForegroundColor Yellow

# Dùng gcloud storage rsync để copy an toàn (chỉ copy file mới/thay đổi)
# -r: recursive, không có --delete nên bucket cũ KHÔNG bị ảnh hưởng
gcloud storage rsync "gs://$OLD_BUCKET" "gs://$NEW_BUCKET" --project=$NEW_PROJECT --recursive --no-clobber

if ($LASTEXITCODE -eq 0) {
    Write-Host "OK - Copy xong" -ForegroundColor Green
} else {
    Write-Host "CÓ LỖI trong quá trình copy. Kiểm tra output ở trên." -ForegroundColor Red
    Write-Host "Thử chạy lại - rsync sẽ tiếp tục từ chỗ bị ngắt." -ForegroundColor Yellow
    exit 1
}

# Kiểm tra số lượng files đã copy
Write-Host ""
Write-Host "[3/3] Check new bucket..." -ForegroundColor Yellow
gcloud storage ls "gs://$NEW_BUCKET" --project=$NEW_PROJECT

Write-Host ""
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "MIGRATE STORAGE DONE!" -ForegroundColor Green
Write-Host "  Source bucket remains: gs://$OLD_BUCKET" -ForegroundColor Cyan
Write-Host "  New bucket: gs://$NEW_BUCKET"
Write-Host ""
Write-Host "NEXT STEP: Run 05-deploy-cloudrun.ps1" -ForegroundColor Yellow
Write-Host "===========================================" -ForegroundColor Cyan
