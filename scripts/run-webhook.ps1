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

function Test-WebhookServer {
  try {
    $config = Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json
    if ($null -eq $config.webhooks -or $config.webhooks.enabled -ne $true) {
      return $false
    }
    $probeHost = if ($config.webhooks.host) { $config.webhooks.host } else { "127.0.0.1" }
    $probePort = if ($config.webhooks.port) { [int]$config.webhooks.port } else { 4312 }
    $client = New-Object System.Net.Sockets.TcpClient
    $async = $client.BeginConnect($probeHost, $probePort, $null, $null)
    $connected = $async.AsyncWaitHandle.WaitOne(500)
    if (-not $connected) {
      $client.Close()
      return $false
    }
    $client.EndConnect($async)
    $client.Close()
    return $true
  } catch {
    return $false
  }
}

New-Item -ItemType Directory -Force -Path $resolvedLogDir | Out-Null
$date = Get-Date -Format "yyyyMMdd"
$outPath = Join-Path $resolvedLogDir "webhook-run-$date.log"
$errPath = Join-Path $resolvedLogDir "webhook-run-$date.err.log"
$metaPath = Join-Path $resolvedLogDir "webhook-meta-$date.log"
$latestPath = Join-Path $resolvedLogDir "latest-webhook-run.path"
$latestMetaPath = Join-Path $resolvedLogDir "latest-webhook-meta.path"

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
Append-MetaLog "=== AgentRunner webhook task start: $(Get-Date -Format o) ==="
Append-MetaLog "Mode: daemon (scheduled task stays running; TaskScheduler MultipleInstancesPolicy=IgnoreNew prevents per-minute relaunch)"
Append-MetaLog "User: $env:USERNAME"
Append-MetaLog "Computer: $env:COMPUTERNAME"
Append-MetaLog "RepoPath: $RepoPath"
Append-MetaLog "ConfigPath: $ConfigPath"
Append-MetaLog "Node: $node"
Append-MetaLog "OutPath: $outPath"
Append-MetaLog "ErrPath: $errPath"

Set-Location -Path $RepoPath
Append-MetaLog "CWD: $(Get-Location)"

while ($true) {
  try {
    if (Test-WebhookServer) {
      Start-Sleep -Seconds 30
      continue
    }

    Append-MetaLog ""
    Append-MetaLog "=== Webhook server start: $(Get-Date -Format o) ==="
    $prevErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $node $script webhook --config $ConfigPath 1>> $outPath 2>> $errPath
    $ErrorActionPreference = $prevErrorActionPreference
    $exitCode = $LASTEXITCODE
    Append-MetaLog "WebhookExitCode: $exitCode"
    Append-MetaLog "=== Webhook server end: $(Get-Date -Format o) ==="
  } catch {
    Append-MetaLog "WebhookException: $($_.Exception.Message)"
  }

  Start-Sleep -Seconds 5
}
