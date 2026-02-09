$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$trayScriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) "scripts\\tray.ps1"
if (-not (Test-Path $trayScriptPath)) {
  throw "tray.ps1 not found: $trayScriptPath"
}

$text = Get-Content -Path $trayScriptPath -Raw
$match = [regex]::Match($text, 'New-Object\s+System\.Threading\.Mutex\(\$true,\s*"(?<name>[^"]+)"', [System.Text.RegularExpressions.RegexOptions]::Multiline)
if (-not $match.Success) {
  throw "Could not find tray mutex name in $trayScriptPath"
}

$name = $match.Groups["name"].Value

$mutex = $null
try {
  # The regression we care about: the mutex name used by tray.ps1 must be a valid
  # named mutex. A previous bug used a name that caused the ctor to throw.
  $mutex = New-Object System.Threading.Mutex($false, $name)

  # Also sanity-check the expected semantics on an isolated name.
  $testName = "$name`_Test_$([Guid]::NewGuid().ToString('N'))"
  $createdNew = $false
  $testMutex = $null
  try {
    $testMutex = New-Object System.Threading.Mutex($true, $testName, [ref]$createdNew)
    if (-not $createdNew) {
      throw "Expected createdNew=true for isolated test mutex (name=$testName)"
    }

    $createdNew2 = $false
    $testMutex2 = $null
    try {
      $testMutex2 = New-Object System.Threading.Mutex($true, $testName, [ref]$createdNew2)
      if ($createdNew2) {
        throw "Expected createdNew=false for second handle (name=$testName)"
      }
    } finally {
      if ($testMutex2) {
        try { $testMutex2.Dispose() } catch {}
      }
    }
  } finally {
    if ($testMutex) {
      try { $testMutex.ReleaseMutex() | Out-Null } catch {}
      try { $testMutex.Dispose() } catch {}
    }
  }
} finally {
  if ($mutex) {
    try { $mutex.Dispose() } catch {}
  }
}

Write-Output "OK: tray single-instance mutex name='$name'"
