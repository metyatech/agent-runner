param(
  [string]$RepoPath = (Split-Path -Parent $PSScriptRoot),
  [string]$ConfigPath = (Join-Path (Split-Path -Parent $PSScriptRoot) "agent-runner.config.json"),
  [string]$LogDir = ""
)

$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $RepoPath "dist\\cli.js"
$resolvedLogDir = if ($LogDir) { $LogDir } else { (Join-Path $RepoPath "logs") }

New-Item -ItemType Directory -Force -Path $resolvedLogDir | Out-Null
$date = Get-Date -Format "yyyyMMdd"
$logPath = Join-Path $resolvedLogDir "task-run-$date.log"
$latestPath = Join-Path $resolvedLogDir "latest-task-run.path"

function Append-Log {
  param([string]$Line)
  $Line | Out-File -FilePath $logPath -Append -Encoding utf8
}

try {
  Set-Content -Path $latestPath -Value "$logPath`n" -Encoding utf8
} catch {
  # best-effort
}

Append-Log ""
Append-Log "=== AgentRunner task start: $(Get-Date -Format o) ==="
Append-Log "User: $env:USERNAME"
Append-Log "Computer: $env:COMPUTERNAME"
Append-Log "RepoPath: $RepoPath"
Append-Log "ConfigPath: $ConfigPath"
Append-Log "Node: $node"
Append-Log "PATH: $env:PATH"
Append-Log "PATHEXT: $env:PATHEXT"
Append-Log "USERPROFILE: $env:USERPROFILE"
Append-Log "APPDATA: $env:APPDATA"
Append-Log "LOCALAPPDATA: $env:LOCALAPPDATA"
Append-Log "AGENT_GITHUB_TOKEN set: $([string]::IsNullOrEmpty($env:AGENT_GITHUB_TOKEN) -ne $true)"
Append-Log "GITHUB_TOKEN set: $([string]::IsNullOrEmpty($env:GITHUB_TOKEN) -ne $true)"
Append-Log "GH_TOKEN set: $([string]::IsNullOrEmpty($env:GH_TOKEN) -ne $true)"

Set-Location -Path $RepoPath
Append-Log "CWD: $(Get-Location)"

& $node $script run --once --yes --config $ConfigPath 2>&1 | Out-File -FilePath $logPath -Append -Encoding utf8
$exitCode = $LASTEXITCODE

Append-Log "ExitCode: $exitCode"
Append-Log "=== AgentRunner task end: $(Get-Date -Format o) ==="
exit $exitCode
