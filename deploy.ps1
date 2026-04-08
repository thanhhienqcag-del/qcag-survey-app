# deploy.ps1 — Init git repo and push to GitHub
# Run this script from the App-2-KS-Khao-Sat directory

$repoUrl = "https://github.com/thanhhienqcag-del/qcag-survey-app.git"
$branch  = "main"

Set-Location $PSScriptRoot

# Find git
$git = "git"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    $candidates = @(
        "C:\Program Files\Git\cmd\git.exe",
        "C:\Program Files\Git\bin\git.exe"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { $git = $c; break }
    }
}

Write-Host "Using git: $git"
& $git --version

# Init if not already a repo
if (-not (Test-Path ".git")) {
    Write-Host "Initializing git repo..."
    & $git init
    & $git branch -M $branch
}

# Set remote
$remoteExists = (& $git remote 2>&1) -match "origin"
if ($remoteExists) {
    Write-Host "Updating remote origin..."
    & $git remote set-url origin $repoUrl
} else {
    Write-Host "Adding remote origin..."
    & $git remote add origin $repoUrl
}

# Stage all changes
Write-Host "Staging all files..."
& $git add -A

# Commit
$date = Get-Date -Format "yyyy-MM-dd HH:mm"
& $git commit -m "chore: update v2.4.0 - $date

- Fix: delete request now works reliably (removed allowNotOk from SDK delete)
- Fix: GCS image folder now uses TK code (e.g. TK26.00001) instead of backend ID
- Fix: push notifications to Heineken mobile now sent via Vercel (same VAPID keys)
- Fix: QCAG delete uses proper confirm modal instead of window.confirm (PWA safe)
- Fix: ksRowToApp now returns tkCode field
- Add: version badge v2.4.0 on mobile home and QCAG desktop sidebar"

Write-Host ""
Write-Host "Pushing to $repoUrl ..."
& $git push -u origin $branch

Write-Host ""
Write-Host "Done! Check: https://github.com/thanhhienqcag-del/qcag-survey-app"
