param(
  [string]$Owner = $env:E2E_GH_OWNER,
  [string]$Repo = $env:E2E_GH_REPO,
  [string]$WorkdirRoot = $env:E2E_WORKDIR_ROOT
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  Write-Error "gh CLI is required. Install it and run 'gh auth login' first."
  exit 1
}

if (-not $Owner) {
  Write-Error "E2E_GH_OWNER is required. Pass -Owner or set E2E_GH_OWNER."
  exit 1
}

if (-not $Repo) {
  Write-Error "E2E_GH_REPO is required. Pass -Repo or set E2E_GH_REPO."
  exit 1
}

if (-not $WorkdirRoot) {
  $WorkdirRoot = Join-Path $env:LOCALAPPDATA "agent-runner\\e2e-workdir"
}

$token = gh auth token
if (-not $token) {
  Write-Error "gh auth token is empty. Run 'gh auth login' and retry."
  exit 1
}

$env:GH_TOKEN = $token
$env:E2E_GH_OWNER = $Owner
$env:E2E_GH_REPO = $Repo
$env:E2E_WORKDIR_ROOT = $WorkdirRoot

New-Item -ItemType Directory -Force -Path $WorkdirRoot | Out-Null

npm run test:e2e
