<#
  stop-copilot-server.ps1 — stop THIS app's server, and nothing else.
  Written 2026-08-29.

  WHY: "START CO-PILOT.bat" used `taskkill /F /IM node.exe`, which kills every
  Node process on the machine. On this setup that is never just the Co-Pilot —
  MCP servers, the claude-mem worker, and any Node tooling that happens to be
  running all die with it, silently, every single launch. Nothing reports it,
  so the damage shows up later as some unrelated thing "just stopped working".

  This targets the server two ways instead, and reports what it did:
    1. Whoever actually holds the listening socket on the app's port. This is
       definitive — if something is on 7433, the new server cannot bind, so it
       must go regardless of what it claims to be.
    2. Any node process whose command line is running server.js from this repo.
       In practice this is what catches leaked tradingview-mcp children, which
       otherwise pile up across launches and fight over the single CDP
       connection. NOTE the Co-Pilot server itself shows up as a bare
       "node  server.js" with no path (the launcher cd's into app\ first), so
       rule 2 does NOT match it - rule 1 is what stops it. That is fine: a
       server that is not holding the port is not blocking the new one. Do not
       "fix" this by matching a bare server.js, which would hit other projects.

  Exits 0 always: having nothing to stop is a success, not an error.
#>
[CmdletBinding()]
param(
  [int]$Port = 7433,
  [string]$RepoRoot = 'G:\MNQ-CoPilot'
)

$stopped = @()

# 1. Whoever holds the port.
try {
  $owners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
              Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($procId in $owners) {
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($p) {
      Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
      $stopped += "pid $procId ($($p.ProcessName)) - held port $Port"
    }
  }
} catch {}

# 2. Any stray server.js belonging to THIS repo.
try {
  $needle = $RepoRoot.TrimEnd('\')
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
    $cmd = $_.CommandLine
    if ($cmd -and $cmd -match 'server\.js' -and $cmd -like "*$needle*") {
      $alive = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
      if ($alive) {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        $stopped += "pid $($_.ProcessId) (node server.js from this repo)"
      }
    }
  }
} catch {}

if ($stopped.Count -eq 0) {
  Write-Host "      Nothing to stop - port $Port was free."
} else {
  foreach ($s in $stopped) { Write-Host "      Stopped $s" }
  # Give the socket a moment to actually release before the new server binds.
  Start-Sleep -Seconds 1
}

exit 0
