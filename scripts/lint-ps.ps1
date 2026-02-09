$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$scriptsDir = Join-Path $repoRoot "scripts"

if (-not (Test-Path $scriptsDir)) {
  Write-Error "scripts directory not found: $scriptsDir"
  exit 1
}

$cmd = Get-Command Invoke-ScriptAnalyzer -ErrorAction SilentlyContinue
if (-not $cmd) {
  Write-Error "PSScriptAnalyzer is not installed. Install it (CurrentUser) then re-run:"
  Write-Output "  powershell -NoProfile -Command \"Install-Module PSScriptAnalyzer -Scope CurrentUser -Force\""
  exit 1
}

$excludedRules = @(
  "PSUseApprovedVerbs",
  "PSUseShouldProcessForStateChangingFunctions",
  "PSAvoidUsingEmptyCatchBlock",
  "PSAvoidUsingWriteHost"
)

$results = Invoke-ScriptAnalyzer -Path $scriptsDir -Recurse -Severity @("Error", "Warning") -ExcludeRule $excludedRules
if ($results -and $results.Count -gt 0) {
  $results |
    Select-Object ScriptName, Line, Column, Severity, RuleName, Message |
    Format-Table -AutoSize |
    Out-String |
    Write-Host
  Write-Error "PSScriptAnalyzer reported $($results.Count) issue(s)."
  exit 1
}

Write-Output "OK: PSScriptAnalyzer"
