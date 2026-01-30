param(
  [string]$TaskName = "AgentRunner",
  [string]$RepoPath = "D:\\ghws\\agent-runner",
  [string]$ConfigPath = "D:\\ghws\\agent-runner\\agent-runner.config.json",
  [int]$IntervalMinutes = 1
)

$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $RepoPath "dist\\cli.js"

$action = New-ScheduledTaskAction -Execute $node -Argument "\"$script\" run --once --yes --config \"$ConfigPath\""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel LeastPrivilege

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force
Write-Host "Registered task $TaskName"
