param(
  [string]$RunnerTaskName = "AgentRunner",
  [string]$LabelTaskName = "AgentRunnerLabelSync",
  [string]$LogDir = "D:\\ghws\\agent-runner\\logs",
  [int]$LogTail = 5
)

Write-Host "== Scheduled Tasks =="
$runnerTask = Get-ScheduledTask -TaskName $RunnerTaskName -ErrorAction SilentlyContinue
$labelTask = Get-ScheduledTask -TaskName $LabelTaskName -ErrorAction SilentlyContinue

if ($runnerTask) {
  $info = Get-ScheduledTaskInfo -TaskName $RunnerTaskName
  Write-Host "$RunnerTaskName:`t$($runnerTask.State)`tLastRun: $($info.LastRunTime)`tNextRun: $($info.NextRunTime)`tLastResult: $($info.LastTaskResult)"
} else {
  Write-Host "$RunnerTaskName:`tNot found"
}

if ($labelTask) {
  $info = Get-ScheduledTaskInfo -TaskName $LabelTaskName
  Write-Host "$LabelTaskName:`t$($labelTask.State)`tLastRun: $($info.LastRunTime)`tNextRun: $($info.NextRunTime)`tLastResult: $($info.LastTaskResult)"
} else {
  Write-Host "$LabelTaskName:`tNot found"
}

Write-Host ""
Write-Host "== Recent Logs =="
if (Test-Path $LogDir) {
  Get-ChildItem $LogDir -File | Sort-Object LastWriteTime -Descending | Select-Object -First $LogTail | ForEach-Object {
    Write-Host "$($_.LastWriteTime) $($_.Name)"
  }
} else {
  Write-Host "Log directory not found: $LogDir"
}
