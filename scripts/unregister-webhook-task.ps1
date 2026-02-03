param(
  [string]$TaskName = "AgentRunnerWebhook"
)

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Unregistered task $TaskName"
