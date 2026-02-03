param(
  [string]$RepoPath = (Split-Path -Parent $PSScriptRoot),
  [string]$LogDir = "",
  [string]$TokenEnv = "CLOUDFLARED_TUNNEL_TOKEN",
  [string]$TokenPath = ""
)

Set-StrictMode -Version Latest

$resolvedTokenPath = if ($TokenPath) { $TokenPath } else { (Join-Path $RepoPath "state\\cloudflared-token.txt") }
$tokenValue = [System.Environment]::GetEnvironmentVariable($TokenEnv)
if ([string]::IsNullOrWhiteSpace($tokenValue) -and (Test-Path $resolvedTokenPath)) {
  $tokenValue = (Get-Content -Path $resolvedTokenPath -Raw).Trim()
}
if ([string]::IsNullOrWhiteSpace($tokenValue)) {
  Write-Error "Missing tunnel token. Set $TokenEnv or create $resolvedTokenPath."
  exit 1
}

$cloudflared = (Get-Command cloudflared -ErrorAction Stop).Source
$resolvedLogDir = if ($LogDir) { $LogDir } else { (Join-Path $RepoPath "logs") }

if (Get-Process cloudflared -ErrorAction SilentlyContinue) {
  exit 0
}

New-Item -ItemType Directory -Force -Path $resolvedLogDir | Out-Null
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $resolvedLogDir "cloudflared-$timestamp.out.log"
$errPath = Join-Path $resolvedLogDir "cloudflared-$timestamp.err.log"

Set-Location -Path $RepoPath
$process = Start-Process -FilePath $cloudflared -ArgumentList @(
  "tunnel",
  "run",
  "--token",
  $tokenValue
) -WorkingDirectory $RepoPath -RedirectStandardOutput $logPath -RedirectStandardError $errPath -NoNewWindow -PassThru -Wait

exit $process.ExitCode
