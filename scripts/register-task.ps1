param(
  [string]$TaskName = "AgentRunner",
  [string]$RepoPath = (Split-Path -Parent $PSScriptRoot),
  [string]$ConfigPath = (Join-Path (Split-Path -Parent $PSScriptRoot) "agent-runner.config.json"),
  [int]$IntervalMinutes = 1
)

$wscript = (Get-Command wscript -ErrorAction Stop).Source
$resolvedRepoPath = (Resolve-Path -Path $RepoPath).Path
$resolvedConfigPath = (Resolve-Path -Path $ConfigPath).Path
$vbs = Join-Path $resolvedRepoPath "scripts\\run-task.vbs"

$action = New-ScheduledTaskAction -Execute $wscript -Argument "//B //NoLogo `"$vbs`"" -WorkingDirectory $resolvedRepoPath
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
  -Hidden `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force
Write-Host "Registered task $TaskName"
