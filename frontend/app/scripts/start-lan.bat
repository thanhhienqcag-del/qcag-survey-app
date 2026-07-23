@echo off
REM Start KS Mobile (both ports) via PowerShell helper
cd /d "%~dp0"
start "KS Mobile Start" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-lan.ps1" -Action start
exit /b 0
