# test-push.ps1 - Simulate QCAG desktop push when marking request done
# Usage examples:
#   .\test-push.ps1 -SaleCode 88000255
#   .\test-push.ps1 -Phone 0966767731
#   .\test-push.ps1 -Role heineken       (broadcast to all Heineken)

param(
  [string]$SaleCode  = "88000255",
  [string]$Phone     = "",
  [string]$Role      = "",
  [string]$BackendId = "TK001",
  [string]$BaseUrl   = "https://qcag-survey-app.vercel.app"
)

$payload = [ordered]@{
  title    = "QCAG - Da co mau quang cao (MQ)"
  body     = "Yeu cau $BackendId da co MQ. Vui long mo app de xem."
  data     = @{ backendId = $BackendId }
}
if ($SaleCode -ne "") { $payload["saleCode"] = $SaleCode }
if ($Phone    -ne "") { $payload["phone"]    = $Phone    }
if ($Role     -ne "") { $payload["role"]     = $Role     }

$json = $payload | ConvertTo-Json -Depth 3 -Compress

Write-Host ""
Write-Host "=== QCAG Push Test ===" -ForegroundColor Cyan
$target = if ($SaleCode -ne "") { "saleCode=$SaleCode" } elseif ($Phone -ne "") { "phone=$Phone" } else { "role=$Role" }
Write-Host "Target  : $target"
Write-Host "Payload : $json"
Write-Host ""

try {
  $resp = Invoke-WebRequest "$BaseUrl/api/ks/push/send" `
    -Method POST `
    -Headers @{ "Content-Type" = "application/json" } `
    -Body $json `
    -UseBasicParsing `
    -ErrorAction Stop

  $result = $resp.Content | ConvertFrom-Json

  if ($result.ok -and $result.sent -gt 0) {
    Write-Host "OK  Sent=$($result.sent)  Failed=$($result.failed)" -ForegroundColor Green
  } elseif ($result.sent -eq 0) {
    Write-Host "WARN  No subscriptions found (sent=0)" -ForegroundColor Yellow
    Write-Host "      Sale needs to re-login on app to re-subscribe"
  } else {
    Write-Host "ERR  $($resp.Content)" -ForegroundColor Red
  }
  Write-Host "Raw: $($resp.Content)"
} catch {
  Write-Host "HTTP Error: $_" -ForegroundColor Red
}
Write-Host ""