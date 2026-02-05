param(
  [string]$RepoPath = (Split-Path -Parent $PSScriptRoot),
  [string]$ConfigPath = (Join-Path (Split-Path -Parent $PSScriptRoot) "agent-runner.config.json"),
  [string]$LogDir = ""
)

Set-StrictMode -Version Latest

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
    $host = if ($config.webhooks.host) { $config.webhooks.host } else { "127.0.0.1" }
    $port = if ($config.webhooks.port) { [int]$config.webhooks.port } else { 4312 }
    $client = New-Object System.Net.Sockets.TcpClient
    $async = $client.BeginConnect($host, $port, $null, $null)
    $connected = $async.AsyncWaitHandle.WaitOne(200)
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

if (Test-WebhookServer) {
  exit 0
}

New-Item -ItemType Directory -Force -Path $resolvedLogDir | Out-Null
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $resolvedLogDir "webhook-run-$timestamp.out.log"
$errPath = Join-Path $resolvedLogDir "webhook-run-$timestamp.err.log"

Set-Location -Path $RepoPath
$process = Start-Process -FilePath $node -ArgumentList @(
  $script,
  "webhook",
  "--config",
  $ConfigPath
) -WorkingDirectory $RepoPath -RedirectStandardOutput $logPath -RedirectStandardError $errPath -WindowStyle Hidden -PassThru

Start-Sleep -Milliseconds 300
if (Test-WebhookServer) {
  exit 0
}
if ($process.HasExited) {
  exit $process.ExitCode
}
exit 0
