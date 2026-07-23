param()

# Create a copy of the current project into the folder 'KS Mobile 1.4.2'
# Excludes common local/generated files and folders.

$source = (Get-Location).ProviderPath
$dest = Join-Path $source 'KS Mobile 1.4.2'

Write-Host "Source: $source"
Write-Host "Destination: $dest"

if (-not (Test-Path $dest)) {
    New-Item -ItemType Directory -Path $dest | Out-Null
}

$excludeDirs = @('node_modules', '.git', '.vercel')
$excludeFiles = @('KS Mobile 1.4.zip','KS Mobile 1.4.1.zip','.env.local','.env')

Write-Host 'Starting copy with robocopy (this preserves structure and metadata)...'

# Build robocopy arguments
$filespec = '*.*'
$xd = $excludeDirs -join ' '
$xf = $excludeFiles -join ' '

# Use robocopy to copy recursively while excluding dirs/files
& robocopy $source $dest $filespec /E /COPYALL /R:1 /W:1 /XD $excludeDirs /XF $excludeFiles | Out-Null

Write-Host 'Copy finished. Review the folder KS Mobile 1.4.2.'
