param(
  [string]$TaskName = "AgentRunnerCloudflared",
  [string]$RepoPath = (Split-Path -Parent $PSScriptRoot),
  [string]$TokenEnv = "CLOUDFLARED_TUNNEL_TOKEN"
)

$wscript = (Get-Command wscript -ErrorAction Stop).Source
$resolvedRepoPath = (Resolve-Path -Path $RepoPath).Path
$vbs = Join-Path $resolvedRepoPath "scripts\\run-cloudflared.vbs"

$action = New-ScheduledTaskAction -Execute $wscript -Argument "//B //NoLogo `"$vbs`" `"$TokenEnv`"" -WorkingDirectory $resolvedRepoPath
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force
Write-Host "Registered task $TaskName"
