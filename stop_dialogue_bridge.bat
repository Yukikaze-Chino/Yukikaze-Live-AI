@echo off
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { Invoke-RestMethod -Uri 'http://127.0.0.1:17374/api/tts/stop' -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 20 | Out-Null } catch {};" ^
  "$connections = Get-NetTCPConnection -LocalPort 17374 -State Listen -ErrorAction SilentlyContinue;" ^
  "$connections | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"

endlocal
