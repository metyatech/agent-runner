param(
  [string]$RepoPath = (Split-Path -Parent $PSScriptRoot),
  [string]$ConfigPath = (Join-Path (Split-Path -Parent $PSScriptRoot) "agent-runner.config.json"),
  [string]$LogDir = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$PSDefaultParameterValues["Out-File:Encoding"] = "utf8"

$hideConsole = {
  try {
    Add-Type -Namespace AgentRunner -Name Win32 -MemberDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Win32 {
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
    $hwnd = [AgentRunner.Win32]::GetConsoleWindow()
    if ($hwnd -ne [IntPtr]::Zero) {
      [void][AgentRunner.Win32]::ShowWindow($hwnd, 0)
    }
  } catch {
    # best-effort
  }
}
& $hideConsole

$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $RepoPath "dist\\cli.js"
$resolvedLogDir = if ($LogDir) { $LogDir } else { (Join-Path $RepoPath "logs") }

New-Item -ItemType Directory -Force -Path $resolvedLogDir | Out-Null
$date = Get-Date -Format "yyyyMMdd"
$outPath = Join-Path $resolvedLogDir "task-run-$date.log"
$errPath = Join-Path $resolvedLogDir "task-run-$date.err.log"
$metaPath = Join-Path $resolvedLogDir "task-meta-$date.log"
$latestPath = Join-Path $resolvedLogDir "latest-task-run.path"
$latestMetaPath = Join-Path $resolvedLogDir "latest-task-meta.path"

function Append-MetaLog {
  param([string]$Line)
  $Line | Out-File -FilePath $metaPath -Append -Encoding utf8
}

try {
  Set-Content -Path $latestPath -Value "$outPath`n" -Encoding utf8
} catch {
  # best-effort
}

try {
  Set-Content -Path $latestMetaPath -Value "$metaPath`n" -Encoding utf8
} catch {
  # best-effort
}

Append-MetaLog ""
Append-MetaLog "=== AgentRunner task start: $(Get-Date -Format o) ==="
Append-MetaLog "User: $env:USERNAME"
Append-MetaLog "Computer: $env:COMPUTERNAME"
Append-MetaLog "RepoPath: $RepoPath"
Append-MetaLog "ConfigPath: $ConfigPath"
Append-MetaLog "Node: $node"
Append-MetaLog "OutPath: $outPath"
Append-MetaLog "ErrPath: $errPath"
Append-MetaLog "PATH: $env:PATH"
Append-MetaLog "PATHEXT: $env:PATHEXT"
Append-MetaLog "USERPROFILE: $env:USERPROFILE"
Append-MetaLog "APPDATA: $env:APPDATA"
Append-MetaLog "LOCALAPPDATA: $env:LOCALAPPDATA"
Append-MetaLog "AGENT_GITHUB_TOKEN set: $([string]::IsNullOrEmpty($env:AGENT_GITHUB_TOKEN) -ne $true)"
Append-MetaLog "GITHUB_TOKEN set: $([string]::IsNullOrEmpty($env:GITHUB_TOKEN) -ne $true)"
Append-MetaLog "GH_TOKEN set: $([string]::IsNullOrEmpty($env:GH_TOKEN) -ne $true)"

Set-Location -Path $RepoPath
Append-MetaLog "CWD: $(Get-Location)"

Append-MetaLog "Mode: daemon (scheduled task stays running; TaskScheduler MultipleInstancesPolicy=IgnoreNew prevents per-minute relaunch)"

while ($true) {
  Append-MetaLog ""
  Append-MetaLog "=== AgentRunner runner start: $(Get-Date -Format o) ==="
  try {
    $prevErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $node $script run --yes --config $ConfigPath 1>> $outPath 2>> $errPath
    $ErrorActionPreference = $prevErrorActionPreference
    $exitCode = $LASTEXITCODE
    Append-MetaLog "RunnerExitCode: $exitCode"
  } catch {
    Append-MetaLog "RunnerException: $($_.Exception.Message)"
    $exitCode = 1
  }

  Append-MetaLog "=== AgentRunner runner end: $(Get-Date -Format o) ==="
  Start-Sleep -Seconds 5
}
