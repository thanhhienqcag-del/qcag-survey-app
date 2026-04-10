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
& $git commit -m "fix: force cache-bust all JS/CSS on all devices - $date

- Fix: add Cache-Control no-cache to all .html and /app/**/*.js|.css in vercel.json
- Fix: add ?v=20260410 to all local script/link tags in index.html
- Ensures all users always load latest JS flow code after deploy"

Write-Host ""
Write-Host "Pushing to $repoUrl ..."
& $git push -u origin $branch

Write-Host ""
Write-Host "Done! Check: https://github.com/thanhhienqcag-del/qcag-survey-app"
