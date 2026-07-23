<#
start-lan.ps1 — Minimal helper to start/stop/status the KS Mobile server

Usage:
  .\start-lan.ps1 -Action start
  .\start-lan.ps1 -Action stop
  .\start-lan.ps1 -Action restart
  .\start-lan.ps1 -Action status
  .\start-lan.ps1 -Action open

This script proxies to the existing `start-localhost3000.ps1` helper which
manages the single Node process that listens on both port 3000 and 3001.
#>

param(
    [ValidateSet('start','stop','restart','status','open')]
    [string]$Action = 'start'
)

$helper = Join-Path $PSScriptRoot 'start-localhost3000.ps1'
if (-not (Test-Path $helper)) {
    Write-Error "Helper not found: $helper`nMake sure you run this from the project root (KS Mobile 1.0)."
    exit 1
}

switch ($Action) {
    'start'   { powershell -ExecutionPolicy Bypass -File $helper -Action start }
    'stop'    { powershell -ExecutionPolicy Bypass -File $helper -Action stop }
    'restart' { powershell -ExecutionPolicy Bypass -File $helper -Action restart }
    'status'  { powershell -ExecutionPolicy Bypass -File $helper -Action status }
    'open'    { powershell -ExecutionPolicy Bypass -File $helper -Action open }
    default   { Write-Output "Unknown action: $Action" }
}
