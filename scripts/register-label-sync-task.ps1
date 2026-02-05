param(
  [string]$TaskName = "AgentRunnerLabelSync",
  [string]$RepoPath = (Split-Path -Parent $PSScriptRoot),
  [string]$ConfigPath = (Join-Path (Split-Path -Parent $PSScriptRoot) "agent-runner.config.json"),
  [string]$DailyAt = "03:00"
)

$wscript = (Get-Command wscript -ErrorAction Stop).Source
$resolvedRepoPath = (Resolve-Path -Path $RepoPath).Path
$resolvedConfigPath = (Resolve-Path -Path $ConfigPath).Path
$vbs = Join-Path $resolvedRepoPath "scripts\\run-label-sync.vbs"

$action = New-ScheduledTaskAction -Execute $wscript -Argument "//B //NoLogo `"$vbs`"" -WorkingDirectory $resolvedRepoPath
$trigger = New-ScheduledTaskTrigger -Daily -At $DailyAt
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force
Write-Host "Registered task $TaskName"
