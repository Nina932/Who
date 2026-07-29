param(
  [int]$Port = 4173
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$cockpitUrl = "http://127.0.0.1:$Port/"

$alreadyRunning = Get-NetTCPConnection `
  -LocalPort $Port `
  -State Listen `
  -ErrorAction SilentlyContinue

if (-not $alreadyRunning) {
  & (Join-Path $PSScriptRoot "start-local.ps1") -Port $Port | Out-Null
}

$deadline = (Get-Date).AddSeconds(45)
do {
  try {
    $response = Invoke-WebRequest `
      -Uri $cockpitUrl `
      -UseBasicParsing `
      -TimeoutSec 2
    if ($response.StatusCode -eq 200) {
      Start-Process $cockpitUrl
      exit 0
    }
  } catch {
    Start-Sleep -Milliseconds 500
  }
} while ((Get-Date) -lt $deadline)

Add-Type -AssemblyName PresentationFramework
[System.Windows.MessageBox]::Show(
  "Morpheus did not become ready on port $Port. Check .dev-server.stderr.log in the project folder.",
  "Morpheus could not start",
  "OK",
  "Error"
) | Out-Null
exit 1
