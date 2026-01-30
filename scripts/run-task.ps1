param(
  [string]$RepoPath = "D:\\ghws\\agent-runner",
  [string]$ConfigPath = "D:\\ghws\\agent-runner\\agent-runner.config.json",
  [string]$LogDir = ""
)

$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $RepoPath "dist\\cli.js"
$resolvedLogDir = if ($LogDir) { $LogDir } else { (Join-Path $RepoPath "logs") }

New-Item -ItemType Directory -Force -Path $resolvedLogDir | Out-Null
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $resolvedLogDir "task-run-$timestamp.log"

"=== AgentRunner task start: $(Get-Date -Format o) ===" | Add-Content -Path $logPath
"User: $env:USERNAME" | Add-Content -Path $logPath
"Computer: $env:COMPUTERNAME" | Add-Content -Path $logPath
"RepoPath: $RepoPath" | Add-Content -Path $logPath
"ConfigPath: $ConfigPath" | Add-Content -Path $logPath
"Node: $node" | Add-Content -Path $logPath
"PATH: $env:PATH" | Add-Content -Path $logPath
"PATHEXT: $env:PATHEXT" | Add-Content -Path $logPath
"USERPROFILE: $env:USERPROFILE" | Add-Content -Path $logPath
"APPDATA: $env:APPDATA" | Add-Content -Path $logPath
"LOCALAPPDATA: $env:LOCALAPPDATA" | Add-Content -Path $logPath
"AGENT_GITHUB_TOKEN set: $([string]::IsNullOrEmpty($env:AGENT_GITHUB_TOKEN) -ne $true)" | Add-Content -Path $logPath
"GITHUB_TOKEN set: $([string]::IsNullOrEmpty($env:GITHUB_TOKEN) -ne $true)" | Add-Content -Path $logPath
"GH_TOKEN set: $([string]::IsNullOrEmpty($env:GH_TOKEN) -ne $true)" | Add-Content -Path $logPath

Set-Location -Path $RepoPath
"CWD: $(Get-Location)" | Add-Content -Path $logPath

& $node $script run --once --yes --config $ConfigPath 1>> $logPath 2>&1
$exitCode = $LASTEXITCODE

"ExitCode: $exitCode" | Add-Content -Path $logPath
"=== AgentRunner task end: $(Get-Date -Format o) ===" | Add-Content -Path $logPath
exit $exitCode
