# ==========================================
# STEP 3: MIGRATE DATABASE
#
# Export from OLD project (qcag-483014) -> Import into NEW project
#
# IMPORTANT:
#   - READ-ONLY from the old project (no writes to production)
#   - Use local backup file if available, otherwise export directly
# ==========================================

$OLD_PROJECT     = "qcag-483014"
$OLD_INSTANCE    = "qcag-user-micro"
$OLD_DB          = "qcag"
$NEW_PROJECT     = "project-e466a86f-15b8-41c1-81a"
$NEW_INSTANCE    = "qcag-db"
$NEW_DB          = "qcag"
$OLD_BUCKET      = "$OLD_PROJECT-qcag-images"
$TEMP_BUCKET     = "$NEW_PROJECT-qcag-images"  # bucket tạm để chứa file export
$SQL_EXPORT_FILE = "qcag-migrate-$(Get-Date -Format 'yyyyMMdd-HHmmss').sql"
$LOCAL_SQL_BACKUP = 'g:\10. Code\QCAG Backup\backup-qcag-db-20260208-230415.sql'

Write-Host "=== MIGRATE DATABASE ===" -ForegroundColor Cyan
Write-Host "Source (OLD) : $OLD_PROJECT/$OLD_INSTANCE/$OLD_DB"
Write-Host "Target (NEW) : $NEW_PROJECT/$NEW_INSTANCE/$NEW_DB"
Write-Host ""

# Check local backup file
Write-Host "[OPTION A] Use local backup file" -ForegroundColor Yellow
if (Test-Path $LOCAL_SQL_BACKUP) {
    Write-Host "  Found: $LOCAL_SQL_BACKUP" -ForegroundColor Green
    $useLocal = Read-Host "Use this local backup? (yes/no)"
} else {
    Write-Host "  Local backup not found" -ForegroundColor Gray
    $useLocal = "no"
}

if ($useLocal -eq "yes") {
    # ---- OPTION A: Import từ file backup local ----
    Write-Host ""
    Write-Host "[1/3] Upload backup file to GCS bucket..." -ForegroundColor Yellow
    gcloud storage cp $LOCAL_SQL_BACKUP "gs://$TEMP_BUCKET/$SQL_EXPORT_FILE" --project=$NEW_PROJECT
    Write-Host "OK - Upload done" -ForegroundColor Green

    Write-Host ""
    Write-Host "[2/3] Import into Cloud SQL new..." -ForegroundColor Yellow
    
    # Cấp quyền Cloud SQL service account đọc bucket
    $SQL_SA = (gcloud sql instances describe $NEW_INSTANCE --project=$NEW_PROJECT --format="value(serviceAccountEmailAddress)" 2>&1)
    Write-Host "  Cloud SQL SA: $SQL_SA"
    
    gcloud storage buckets add-iam-policy-binding "gs://$TEMP_BUCKET" --member="serviceAccount:$SQL_SA" --role="roles/storage.objectViewer" --project=$NEW_PROJECT 2>&1 | Out-Null
    
    gcloud sql import sql $NEW_INSTANCE "gs://$TEMP_BUCKET/$SQL_EXPORT_FILE" --project=$NEW_PROJECT --database=$NEW_DB --quiet
    
    Write-Host "OK - Import done" -ForegroundColor Green
    
    Write-Host ""
    Write-Host "[3/3] Cleanup temp file..." -ForegroundColor Yellow
    gcloud storage rm "gs://$TEMP_BUCKET/$SQL_EXPORT_FILE" --project=$NEW_PROJECT 2>&1 | Out-Null
    Write-Host "OK" -ForegroundColor Green
    
} else {
    # ---- OPTION B: Export trực tiếp từ Cloud SQL cũ ----
    Write-Host ""
    Write-Host "[OPTION B] Export directly from old Cloud SQL (READ-ONLY)" -ForegroundColor Yellow
    Write-Host "  NO changes to old project $OLD_PROJECT" -ForegroundColor Green
    Write-Host ""
    
    Write-Host "[1/4] Grant old Cloud SQL write access to new bucket (temporary)..." -ForegroundColor Yellow
    $OLD_SQL_SA = (gcloud sql instances describe $OLD_INSTANCE --project=$OLD_PROJECT --format="value(serviceAccountEmailAddress)" 2>&1)
    Write-Host "  Old Cloud SQL SA: $OLD_SQL_SA"
    
    # Cấp quyền tạm để export
    gcloud storage buckets add-iam-policy-binding "gs://$TEMP_BUCKET" --member="serviceAccount:$OLD_SQL_SA" --role="roles/storage.objectAdmin" --project=$NEW_PROJECT 2>&1 | Out-Null
    Write-Host "OK - Temporary permission granted" -ForegroundColor Green

    Write-Host ""
    Write-Host "[2/4] Export database from OLD project to NEW bucket..." -ForegroundColor Yellow
    Write-Host "  (This action only READS from old project - safe)" -ForegroundColor Cyan
    
    # Export từ Cloud SQL cũ vào bucket MỚI
    gcloud sql export sql $OLD_INSTANCE "gs://$TEMP_BUCKET/$SQL_EXPORT_FILE" --project=$OLD_PROJECT --database=$OLD_DB --offload
    
    Write-Host "OK - Export done" -ForegroundColor Green

    Write-Host ""
    Write-Host "[3/4] Import into NEW Cloud SQL..." -ForegroundColor Yellow
    $NEW_SQL_SA = (gcloud sql instances describe $NEW_INSTANCE --project=$NEW_PROJECT --format="value(serviceAccountEmailAddress)" 2>&1)
    
    gcloud storage buckets add-iam-policy-binding "gs://$TEMP_BUCKET" --member="serviceAccount:$NEW_SQL_SA" --role="roles/storage.objectViewer" --project=$NEW_PROJECT 2>&1 | Out-Null
    
    gcloud sql import sql $NEW_INSTANCE "gs://$TEMP_BUCKET/$SQL_EXPORT_FILE" --project=$NEW_PROJECT --database=$NEW_DB --quiet
    
    Write-Host "OK - Import done" -ForegroundColor Green

    Write-Host ""
    Write-Host "[4/4] Revoke temporary permissions and cleanup..." -ForegroundColor Yellow
    # Revoke temporary permission of old Cloud SQL
    gcloud storage buckets remove-iam-policy-binding "gs://$TEMP_BUCKET" --member="serviceAccount:$OLD_SQL_SA" --role="roles/storage.objectAdmin" --project=$NEW_PROJECT 2>&1 | Out-Null
    
    gcloud storage rm "gs://$TEMP_BUCKET/$SQL_EXPORT_FILE" --project=$NEW_PROJECT 2>&1 | Out-Null
    Write-Host "OK - Cleanup done" -ForegroundColor Green
}

Write-Host ""
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "MIGRATE DATABASE DONE!" -ForegroundColor Green
Write-Host ""
Write-Host "NEXT STEP: Run 04-migrate-storage.ps1" -ForegroundColor Yellow
Write-Host "===========================================" -ForegroundColor Cyan
