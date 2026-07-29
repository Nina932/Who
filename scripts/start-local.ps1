param(
  [int]$Port = 4173
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$environmentFile = Join-Path $repoRoot ".env.local"

if (Test-Path -LiteralPath $environmentFile) {
  Get-Content -LiteralPath $environmentFile | ForEach-Object {
    if ($_ -match "^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$") {
      $name = $matches[1]
      $value = $matches[2].Trim()
      if (
        ($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))
      ) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      # The project-local file wins over stale variables inherited from
      # Codex Desktop or another terminal.
      Set-Item -LiteralPath "Env:$name" -Value $value
    }
  }
}

$existingWorkerIds = @(
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.CommandLine -like "*scripts/telegram-bot.ts*" -and
      $_.ProcessId -ne $PID
    } |
    Select-Object -ExpandProperty ProcessId
)
if ($existingWorkerIds.Count) {
  Stop-Process -Id $existingWorkerIds -Force -ErrorAction SilentlyContinue
}

$dev = Start-Process `
  -FilePath "npm.cmd" `
  -ArgumentList @("run", "dev", "--", "-p", "$Port") `
  -WorkingDirectory $repoRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $repoRoot ".dev-server.stdout.log") `
  -RedirectStandardError (Join-Path $repoRoot ".dev-server.stderr.log") `
  -PassThru

$telegram = Start-Process `
  -FilePath "npm.cmd" `
  -ArgumentList @("run", "telegram:bot") `
  -WorkingDirectory $repoRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $repoRoot ".telegram-worker.stdout.log") `
  -RedirectStandardError (Join-Path $repoRoot ".telegram-worker.stderr.log") `
  -PassThru

[pscustomobject]@{
  DevLauncher = $dev.Id
  TelegramLauncher = $telegram.Id
  Port = $Port
}
