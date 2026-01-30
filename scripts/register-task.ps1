param(
  [string]$TaskName = "AgentRunner",
  [string]$RepoPath = "D:\\ghws\\agent-runner",
  [string]$ConfigPath = "D:\\ghws\\agent-runner\\agent-runner.config.json",
  [int]$IntervalMinutes = 1
)

$powershell = (Get-Command powershell -ErrorAction Stop).Source
$script = Join-Path $RepoPath "scripts\\run-task.ps1"

$action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -RepoPath `"$RepoPath`" -ConfigPath `"$ConfigPath`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force
Write-Host "Registered task $TaskName"
