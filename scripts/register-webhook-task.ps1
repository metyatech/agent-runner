param(
  [string]$TaskName = "AgentRunnerWebhook",
  [string]$RepoPath = (Split-Path -Parent $PSScriptRoot),
  [string]$ConfigPath = (Join-Path (Split-Path -Parent $PSScriptRoot) "agent-runner.config.json")
)

$powershell = (Get-Command powershell -ErrorAction Stop).Source
$resolvedRepoPath = (Resolve-Path -Path $RepoPath).Path
$resolvedConfigPath = (Resolve-Path -Path $ConfigPath).Path
$script = Join-Path $resolvedRepoPath "scripts\\run-webhook.ps1"

$action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -RepoPath `"$resolvedRepoPath`" -ConfigPath `"$resolvedConfigPath`"" -WorkingDirectory $resolvedRepoPath
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force
Write-Host "Registered task $TaskName"
