@echo off
REM Stop KS Mobile server (both ports) via PowerShell helper
cd /d "%~dp0"
start "KS Mobile Stop" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-lan.ps1" -Action stop
exit /b 0
