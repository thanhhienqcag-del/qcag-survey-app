<#
PowerShell helper to start/stop/check a local server on port 3001.
Place this file in your project root (same folder as `server.js` and `package.json`).
Usage examples:
  .\start-localhost3001.ps1 -Action start
  .\start-localhost3001.ps1 -Action stop
  .\start-localhost3001.ps1 -Action status
  .\start-localhost3001.ps1 -Action restart
  .\start-localhost3001.ps1 -Action open
#>

param(
    [ValidateSet("start","stop","status","restart","open")]
    [string]$Action = "start",
    [string]$ProjectPath = $PSScriptRoot
)

function Get-LanIPv4 {
    try {
        $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object { $_.IPAddress -match '^\d{1,3}(\.\d{1,3}){3}$' -and $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notmatch 'Loopback' } |
            Select-Object -First 1 -ExpandProperty IPAddress
        if ($ip) { return $ip }
    } catch {
    }

    $ipconfigText = (& ipconfig | Out-String)
    $ipMatches = [regex]::Matches($ipconfigText, '\b(\d{1,3}(?:\.\d{1,3}){3})\b')
    foreach ($m in $ipMatches) {
        $candidate = $m.Groups[1].Value
        if ($candidate -notlike '127.*' -and $candidate -notlike '169.254.*') {
            return $candidate
        }
    }

    return $null
}

function Get-ServerPids {
    $pids = @()
    foreach ($port in @(3000, 3001)) {
        try {
            $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
            if ($conn) { $pids += ($conn | Select-Object -ExpandProperty OwningProcess) }
        } catch {
            $netstat = & netstat -ano 2>$null | Select-String "\s+:$port\s+.*LISTENING\s+"
            if ($netstat) {
                foreach ($line in $netstat) {
                    $parts = ($line.ToString() -split '\s+') | Where-Object { $_ -ne '' }
                    if ($parts.Length -gt 0) { $pids += [int]$parts[-1] }
                }
            }
        }
    }
    return $pids | Sort-Object -Unique
}

function Start-Server {
    $existingPids = Get-ServerPids
    if ($existingPids.Count -gt 0) {
        $procInfo = $existingPids | ForEach-Object {
            $p = Get-Process -Id $_ -ErrorAction SilentlyContinue
            if ($p) { "PID $($p.Id) ($($p.ProcessName))" }
        }
        Write-Output "Server already running on port 3000/3001: $($procInfo -join ', ')"
        return
    }
    Write-Output "Starting server in: $ProjectPath"
    Start-Process -FilePath npm.cmd -ArgumentList 'start' -WorkingDirectory $ProjectPath -WindowStyle Hidden
    Start-Sleep -Seconds 3
    $check3000 = Test-NetConnection -ComputerName localhost -Port 3000 -WarningAction SilentlyContinue -InformationAction SilentlyContinue
    $check3001 = Test-NetConnection -ComputerName localhost -Port 3001 -WarningAction SilentlyContinue -InformationAction SilentlyContinue
    if ($check3000.TcpTestSucceeded -and $check3001.TcpTestSucceeded) {
        Write-Output "Server started and listening on localhost:3000 and localhost:3001"
        $lanIp = Get-LanIPv4
        if ($lanIp) {
            Write-Output "LAN: http://${lanIp}:3000"
            Write-Output "LAN: http://${lanIp}:3001"
        }
    } else {
        Write-Output "Server start requested. It may take a few seconds for the app to be available."
    }
}

function Stop-Server {
    $pids = Get-ServerPids
    if ($pids.Count -gt 0) {
        foreach ($serverPid in $pids) {
            $proc = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
            if ($proc) {
                Write-Output "Stopping process $($proc.ProcessName) (PID $($proc.Id)) listening on port 3000/3001..."
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            }
        }
        Start-Sleep -Milliseconds 700
        if ((Get-ServerPids).Count -eq 0) { Write-Output "Stopped." } else { Write-Output "Failed to stop listener." }
    } else {
        Write-Output "No process is listening on port 3000/3001."
    }
}

function Open-Browser {
    Start-Process "http://localhost:3001"
}

switch ($Action) {
    'start' { Start-Server; Open-Browser }
    'stop'  { Stop-Server }
    'restart' { Stop-Server; Start-Server; Open-Browser }
    'status' {
        $pids = Get-ServerPids
        if ($pids.Count -gt 0) {
            $procInfo = $pids | ForEach-Object {
                $p = Get-Process -Id $_ -ErrorAction SilentlyContinue
                if ($p) { "PID $($p.Id) ($($p.ProcessName))" }
            }
            Write-Output "Listening on shared server: $($procInfo -join ', ')"
        } else {
            Write-Output "Port 3000/3001 not listening."
        }
    }
    'open' { Open-Browser }
    default { Write-Output "Unknown action: $Action" }
}
