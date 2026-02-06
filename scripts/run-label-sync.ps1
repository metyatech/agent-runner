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
$outPath = Join-Path $resolvedLogDir "label-sync-$date.log"
$errPath = Join-Path $resolvedLogDir "label-sync-$date.err.log"

Set-Location -Path $RepoPath

$prevErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $node $script labels sync --yes --config $ConfigPath 1>> $outPath 2>> $errPath
$exitCode = $LASTEXITCODE
$ErrorActionPreference = $prevErrorActionPreference

exit $exitCode
