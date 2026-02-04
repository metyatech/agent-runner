param(
  [Parameter(Mandatory = $true)]
  [string]$AppId,
  [Parameter(Mandatory = $true)]
  [int]$InstallationId,
  [Parameter(Mandatory = $true)]
  [string]$PrivateKeyPath,
  [string]$ApiBaseUrl = "",
  [string]$RepoPath = (Split-Path -Parent $PSScriptRoot)
)

Set-StrictMode -Version Latest

if (-not (Test-Path -Path $PrivateKeyPath)) {
  throw "PrivateKeyPath not found: $PrivateKeyPath"
}

$stateDir = Join-Path $RepoPath "state"
$appJsonPath = Join-Path $stateDir "github-notify-app.json"
$keyOutPath = Join-Path $stateDir "github-notify-app-private-key.pem"

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

Copy-Item -Force -Path $PrivateKeyPath -Destination $keyOutPath

$payload = @{
  appId = $AppId
  installationId = $InstallationId
}
if (-not [string]::IsNullOrWhiteSpace($ApiBaseUrl)) {
  $payload.apiBaseUrl = $ApiBaseUrl
}

($payload | ConvertTo-Json -Depth 4) + "`n" | Set-Content -Path $appJsonPath -Encoding utf8

Write-Host "Wrote GitHub notify app config to: $appJsonPath"
Write-Host "Copied private key to: $keyOutPath"
Write-Host "Restart agent-runner to apply (or wait for next scheduled run)."

