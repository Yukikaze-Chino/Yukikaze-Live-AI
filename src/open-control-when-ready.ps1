param(
  [Parameter(Mandatory = $true)]
  [string]$ControlUrl,

  [Parameter(Mandatory = $true)]
  [string]$StatusUrl,

  [Parameter(Mandatory = $true)]
  [string]$LogPath,

  [int]$TimeoutSeconds = 120
)

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$lastError = ""

while ((Get-Date) -lt $deadline) {
  try {
    $status = Invoke-RestMethod -Uri $StatusUrl -TimeoutSec 3
    if ($status.ok) {
      Start-Process $ControlUrl
      exit 0
    }
  } catch {
    $lastError = $_.Exception.Message
  }

  Start-Sleep -Milliseconds 500
}

$logDirectory = Split-Path -Parent $LogPath
if ($logDirectory) {
  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
}

$message = "[{0}] Control page did not become ready within {1} seconds. Last error: {2}" -f `
  (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), `
  $TimeoutSeconds, `
  $lastError
Add-Content -LiteralPath $LogPath -Value $message -Encoding utf8
exit 1
