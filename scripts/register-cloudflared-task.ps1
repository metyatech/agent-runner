param(
  [string]$TaskName = "AgentRunnerCloudflared",
  [string]$RepoPath = (Split-Path -Parent $PSScriptRoot),
  [string]$TokenEnv = "CLOUDFLARED_TUNNEL_TOKEN"
)

$powershell = (Get-Command powershell -ErrorAction Stop).Source
$resolvedRepoPath = (Resolve-Path -Path $RepoPath).Path
$script = Join-Path $resolvedRepoPath "scripts\\run-cloudflared.ps1"

$action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -RepoPath `"$resolvedRepoPath`" -TokenEnv `"$TokenEnv`"" -WorkingDirectory $resolvedRepoPath
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force
Write-Host "Registered task $TaskName"
