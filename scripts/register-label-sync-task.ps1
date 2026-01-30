param(
  [string]$TaskName = "AgentRunnerLabelSync",
  [string]$RepoPath = "D:\\ghws\\agent-runner",
  [string]$ConfigPath = "D:\\ghws\\agent-runner\\agent-runner.config.json",
  [string]$DailyAt = "03:00"
)

$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $RepoPath "dist\\cli.js"

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`" labels sync --yes --config `"$ConfigPath`""
$trigger = New-ScheduledTaskTrigger -Daily -At $DailyAt
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force
Write-Host "Registered task $TaskName"
