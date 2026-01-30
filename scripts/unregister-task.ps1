param(
  [string]$TaskName = "AgentRunner"
)

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Unregistered task $TaskName"
