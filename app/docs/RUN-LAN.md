# Start KS Mobile (both ports) — One-command helper

From the project folder `KS Mobile 1.0`, run the single PowerShell helper to start/stop the local server that listens on both port `3000` and `3001` and is reachable on your LAN.

Examples:

```powershell
# Start the server (both ports)
.\start-lan.ps1 -Action start

# Stop the server
.\start-lan.ps1 -Action stop

# Restart
.\start-lan.ps1 -Action restart

# Check status
.\start-lan.ps1 -Action status

# Open in default browser (port 3000)
.\start-lan.ps1 -Action open
```

Notes:
- Run these commands in PowerShell from the `KS Mobile 1.0` folder.
- The helper proxies to `start-localhost3000.ps1`, which manages a single Node process bound to `0.0.0.0` and serving both `3000` and `3001`.
- If your phone can't reach the server, ensure the phone is on the same Wi‑Fi (not a Guest network) and that `AP/Client Isolation` is disabled on the router.
