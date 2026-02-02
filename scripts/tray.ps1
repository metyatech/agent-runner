param(
  [string]$RepoPath = (Split-Path -Parent $PSScriptRoot),
  [string]$ConfigPath = (Join-Path (Split-Path -Parent $PSScriptRoot) "agent-runner.config.json"),
  [string]$StatusHost = "127.0.0.1",
  [int]$StatusPort = 4311,
  [string]$RunnerTaskName = "AgentRunner"
)

Set-StrictMode -Version Latest

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$cliPath = Join-Path $RepoPath "dist\\cli.js"
$statusProcess = $null

function Test-StatusServer {
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $async = $client.BeginConnect($StatusHost, $StatusPort, $null, $null)
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

function Ensure-StatusServer {
  if (Test-StatusServer) {
    return
  }
  if (-not (Test-Path $cliPath)) {
    return
  }
  $args = @(
    $cliPath,
    "ui",
    "--config",
    $ConfigPath,
    "--host",
    $StatusHost,
    "--port",
    $StatusPort
  )
  $statusProcess = Start-Process -FilePath "node" -ArgumentList $args -WorkingDirectory $RepoPath -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 300
}

function Open-StatusUi {
  Ensure-StatusServer
  Start-Process "http://$StatusHost`:$StatusPort/"
}

function Get-StatusSnapshot {
  if (-not (Test-Path $cliPath)) {
    return $null
  }
  $raw = & node $cliPath status --config $ConfigPath --json 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) {
    return $null
  }
  try {
    return $raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Request-Stop {
  if (-not (Test-Path $cliPath)) {
    return
  }
  & node $cliPath stop --config $ConfigPath 1>$null 2>$null
  try {
    Stop-ScheduledTask -TaskName $RunnerTaskName -ErrorAction SilentlyContinue | Out-Null
  } catch {
    # ignore
  }
}

function Resume-Runner {
  if (-not (Test-Path $cliPath)) {
    return
  }
  & node $cliPath resume --config $ConfigPath 1>$null 2>$null
  try {
    Start-ScheduledTask -TaskName $RunnerTaskName -ErrorAction SilentlyContinue | Out-Null
  } catch {
    # ignore
  }
}

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
$notifyIcon.Text = "Agent Runner"
$notifyIcon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.Items.Add("Open Status UI", $null, { Open-StatusUi }) | Out-Null
$menu.Items.Add("Pause Runner", $null, { Request-Stop }) | Out-Null
$menu.Items.Add("Resume Runner", $null, { Resume-Runner }) | Out-Null
$menu.Items.Add("Exit", $null, {
  if ($statusProcess -and -not $statusProcess.HasExited) {
    try {
      $statusProcess.CloseMainWindow() | Out-Null
      Start-Sleep -Milliseconds 200
      if (-not $statusProcess.HasExited) {
        $statusProcess.Kill()
      }
    } catch {
      # ignore
    }
  }
  $notifyIcon.Visible = $false
  $notifyIcon.Dispose()
  [System.Windows.Forms.Application]::Exit()
}) | Out-Null

$notifyIcon.ContextMenuStrip = $menu
$notifyIcon.add_DoubleClick({ Open-StatusUi })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({
  $snapshot = Get-StatusSnapshot
  if ($null -eq $snapshot) {
    $notifyIcon.Text = "Agent Runner - Unknown"
    return
  }
  $state = "Idle"
  if ($snapshot.stopRequested -and $snapshot.busy) {
    $state = "Running (stop)"
  } elseif ($snapshot.stopRequested) {
    $state = "Paused"
  } elseif ($snapshot.busy) {
    $state = "Running"
  }
  $count = 0
  if ($snapshot.running) {
    $count = $snapshot.running.Count
  }
  $text = "Agent Runner - $state"
  if ($count -gt 0) {
    $text = "$text ($count)"
  }
  if ($text.Length -gt 60) {
    $text = $text.Substring(0, 60)
  }
  $notifyIcon.Text = $text
}) | Out-Null
$timer.Start()

[System.Windows.Forms.Application]::Run()
