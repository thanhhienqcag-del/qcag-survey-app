<#
Runs a set of checks to diagnose LAN accessibility for ports 3000 and 3001.
Usage: run from project root in an elevated PowerShell prompt:
  .\diagnose-lan-access.ps1
#>

Write-Output "== Local IPv4 addresses (non-loopback, non-APIPA) =="
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object IPAddress, InterfaceAlias, PrefixOrigin | Format-Table -AutoSize

Write-Output "`n== Netstat entries for ports 3000/3001 =="
netstat -ano | Select-String ":3000|:3001" | ForEach-Object { $_.ToString() }

Write-Output "`n== Get-NetTCPConnection listeners for 3000/3001 =="
Get-NetTCPConnection -LocalPort 3000,3001 -State Listen | Format-Table LocalAddress,LocalPort,OwningProcess -AutoSize

Write-Output "`n== Which process (node) is running =="
Get-Process -Name node -ErrorAction SilentlyContinue | Format-Table Id,ProcessName,Path -AutoSize

Write-Output "`n== Test-NetConnection to localhost and each local IP on ports 3000/3001 =="
$ips = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -ExpandProperty IPAddress
foreach ($ip in $ips) {
    Write-Output "-- Testing $ip --"
    Test-NetConnection -ComputerName $ip -Port 3000 -WarningAction SilentlyContinue | Format-List
    Test-NetConnection -ComputerName $ip -Port 3001 -WarningAction SilentlyContinue | Format-List
}
Write-Output "-- Testing localhost --"
Test-NetConnection -ComputerName localhost -Port 3000 | Format-List
Test-NetConnection -ComputerName localhost -Port 3001 | Format-List

Write-Output "`n== Firewall rules we added =="
Get-NetFirewallRule -DisplayName "KS Mobile TCP*" | Format-Table Name,DisplayName,Enabled,Profile,Direction -AutoSize

Write-Output "`n== Firewall profiles =="
Get-NetFirewallProfile | Format-Table Name,Enabled -AutoSize

Write-Output "`n== Suggestion =="
Write-Output "- If listeners show LocalAddress 0.0.0.0 or any IPv4, server is bound correctly."
Write-Output "- If Test-NetConnection to local IP fails but localhost succeeds, check Windows Firewall and network profile (ensure Private)."
Write-Output "- Verify your phone's Wi-Fi IP is in the same subnet as one of the local IPs above."
