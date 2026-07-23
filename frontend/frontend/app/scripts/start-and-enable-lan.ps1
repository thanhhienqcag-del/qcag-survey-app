<#
Start-and-enable-lan.ps1
Starts the project's server (runs `npm start` in the script folder),
ensures firewall rules exist for TCP 3000 and 3001 so devices on the same
Wi‑Fi can access the app, and prints the LAN URLs to use from mobile.

Usage: run from any PowerShell prompt. The script will relaunch itself as
administrator if needed (to create firewall rules).
#>

function Ensure-RunningAsAdmin {
    $current = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($current)
    $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
    if (-not $isAdmin) {
        Write-Output "Elevating to administrator to manage firewall rules..."
        Start-Process -FilePath powershell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
        Exit
    }
}

Ensure-RunningAsAdmin

# Resolve project path to the folder where this script lives (works if script moved/renamed)
$ScriptFile = $MyInvocation.MyCommand.Definition
if (-not $ScriptFile) { $ScriptFile = $PSCommandPath }
$ProjectPath = Split-Path -Parent $ScriptFile
Set-Location $ProjectPath

Write-Output "Project path: $ProjectPath"

function Is-Port-Listening($port) {
    try { return (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop) -ne $null } catch { return $false }
}

function Start-ProjectServer {
    if (Is-Port-Listening 3000 -and Is-Port-Listening 3001) {
        Write-Output "Server already listening on 3000 and 3001."
        return
    }
    Write-Output "Starting server with 'npm start' in $ProjectPath"
    Start-Process -FilePath npm.cmd -ArgumentList 'start' -WorkingDirectory $ProjectPath -WindowStyle Hidden
    # wait for listeners to appear (up to 15s)
    $tries = 0
    while ($tries -lt 15) {
        Start-Sleep -Seconds 1
        if (Is-Port-Listening 3000 -and Is-Port-Listening 3001) { break }
        $tries++
    }
    if (Is-Port-Listening 3000 -and Is-Port-Listening 3001) { Write-Output "Server is listening on 3000 and 3001." } else { Write-Output "Warning: server did not open both ports within timeout." }
}

function Ensure-FirewallRule($displayName, $port, $profile) {
    $existing = Get-NetFirewallRule -DisplayName $displayName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Output "Firewall rule '$displayName' already exists."
        return
    }
    Write-Output "Creating firewall rule for $port (Profile: $profile)"
    New-NetFirewallRule -DisplayName $displayName -Direction Inbound -LocalPort $port -Protocol TCP -Action Allow -Profile $profile | Out-Null
}

# Choose profile: prefer Private when enabled, otherwise Any
$profileToUse = if ((Get-NetFirewallProfile -Profile Private).Enabled) { 'Private' } else { 'Any' }

Ensure-FirewallRule -displayName 'KS Mobile TCP 3000' -port 3000 -profile $profileToUse
Ensure-FirewallRule -displayName 'KS Mobile TCP 3001' -port 3001 -profile $profileToUse

Start-ProjectServer

# Find candidate LAN IPs and report reachable URLs
$ips = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -ExpandProperty IPAddress
Write-Output "\nAvailable local IP addresses:";
$ips | ForEach-Object { Write-Output " - $_" }

foreach ($ip in $ips) {
    $t3000 = Test-NetConnection -ComputerName $ip -Port 3000 -WarningAction SilentlyContinue
    $t3001 = Test-NetConnection -ComputerName $ip -Port 3001 -WarningAction SilentlyContinue
    if ($t3000.TcpTestSucceeded -or $t3001.TcpTestSucceeded) {
        Write-Output "\nReachable from LAN on $ip:"
        if ($t3000.TcpTestSucceeded) { Write-Output " - http://$ip:3000/" }
        if ($t3001.TcpTestSucceeded) { Write-Output " - http://$ip:3001/" }
    }
}

Write-Output "\nIf your phone is on the same Wi‑Fi subnet as one of the IPs above, open the corresponding http://<IP>:3000 or :3001 in the phone browser."
