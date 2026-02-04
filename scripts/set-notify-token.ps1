param(
  [Parameter(Mandatory = $true)]
  [string]$Token,
  [string]$RepoPath = (Split-Path -Parent $PSScriptRoot)
)

$stateDir = Join-Path $RepoPath "state"
$tokenPath = Join-Path $stateDir "github-notify-token.txt"

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
Set-Content -Path $tokenPath -Value ($Token.Trim() + "`n") -Encoding utf8
Write-Host "Wrote GitHub notify token to: $tokenPath"
Write-Host "Restart agent-runner to apply (or wait for next scheduled run)."

