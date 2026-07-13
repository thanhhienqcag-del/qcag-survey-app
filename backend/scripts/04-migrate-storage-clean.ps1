#!/usr/bin/env pwsh
# Clean storage migration script (ASCII-only)
$OLD_PROJECT = "qcag-483014"
$NEW_PROJECT = "project-e466a86f-15b8-41c1-81a"
$OLD_BUCKET  = "$OLD_PROJECT-qcag-images"
$NEW_BUCKET  = "$NEW_PROJECT-qcag-images"

Write-Host "=== MIGRATE STORAGE (CLEAN) ===" -ForegroundColor Cyan
Write-Host "Source bucket: gs://$OLD_BUCKET" -ForegroundColor Yellow
Write-Host "Target bucket: gs://$NEW_BUCKET" -ForegroundColor Yellow

Write-Host "[1/3] Listing source files..." -ForegroundColor Yellow
$files = gcloud storage ls "gs://$OLD_BUCKET/**" --project=$OLD_PROJECT 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "Failed to list source bucket." -ForegroundColor Red; exit 1 }
$fileCount = ($files | Measure-Object -Line).Lines
Write-Host "Approx files: $fileCount"

$confirm = Read-Host "Start copy? (yes/no)"
if ($confirm -ne 'yes') { Write-Host "Cancelled" -ForegroundColor Red; exit 0 }

Write-Host "[2/3] Running rsync..." -ForegroundColor Yellow
gcloud storage rsync "gs://$OLD_BUCKET" "gs://$NEW_BUCKET" --project=$NEW_PROJECT --recursive --no-clobber
if ($LASTEXITCODE -ne 0) { Write-Host "rsync failed" -ForegroundColor Red; exit 1 }
Write-Host "rsync completed" -ForegroundColor Green

Write-Host "[3/3] Listing target bucket..." -ForegroundColor Yellow
gcloud storage ls "gs://$NEW_BUCKET" --project=$NEW_PROJECT

Write-Host "MIGRATE STORAGE DONE" -ForegroundColor Green
