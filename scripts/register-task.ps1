param(
  [string]$TaskName = "AgentRunner",
  [string]$RepoPath = (Split-Path -Parent $PSScriptRoot),
  [string]$ConfigPath = (Join-Path (Split-Path -Parent $PSScriptRoot) "agent-runner.config.json"),
  [int]$IntervalMinutes = 1
)

$powershell = (Get-Command powershell -ErrorAction Stop).Source
$resolvedRepoPath = (Resolve-Path -Path $RepoPath).Path
$resolvedConfigPath = (Resolve-Path -Path $ConfigPath).Path
$script = Join-Path $resolvedRepoPath "scripts\\run-task.ps1"

$action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -RepoPath `"$resolvedRepoPath`" -ConfigPath `"$resolvedConfigPath`"" -WorkingDirectory $resolvedRepoPath
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet -Hidden
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force
Write-Host "Registered task $TaskName"
