<#
  ensure-tradingview.ps1 — get TradingView Desktop up with CDP, fast.
  Written 2026-08-29 to fix two real failures in "START CO-PILOT.bat".

  FAILURE 1 — the hardcoded version folder went stale.
    The launcher pointed at
      ...\31178TradingViewInc.TradingView_3.3.0.0_x64__q4jpyh43s5mv6\TradingView.exe
    TradingView auto-updated itself to 3.4.0.0, which is a DIFFERENT folder, so
    the path stopped existing and the launcher silently skipped starting it.
    Its own comment predicted this ("It has probably auto-updated to a new
    version folder") but the fix was "tell Claude" — a human step, in the one
    place that is supposed to be one-click. This resolves the path at run time
    from the package registration instead, so an update cannot break it again.

  FAILURE 2 — the readiness poll took minutes to fail.
    The old loop spawned a brand-new `powershell -NoProfile` process per
    attempt, 45 times, each paying ~1s of PowerShell start-up plus a 2s
    timeout. When TradingView was not running (i.e. exactly when failure 1 had
    just happened) that is over two minutes of dead waiting before the launcher
    gave up. One process now does the whole poll.

  ALSO: if CDP is already answering, TradingView is already running WITH the
  debug flag, so there is nothing to fix — this reuses it instead of killing a
  working chart and paying the whole cold-start again. Anoop may have started
  it himself via "Prop Trading\Launch TradingView (CDP).bat".

  Exit codes:  0 = CDP is up and answering.  1 = it is not.
  The caller decides what to do about a 1; this script never kills the session.
#>
[CmdletBinding()]
param(
  [int]$Port = 9222,
  [int]$TimeoutSec = 90,
  # Skip the reuse check and force a clean restart of TradingView.
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

# ── 127.0.0.1, NEVER "localhost" ────────────────────────────────────────────
# THE BUG THAT MADE THE LAUNCHER SLOW, found 2026-08-29 by measuring it:
# "localhost" resolves to the IPv6 loopback ::1 first on this machine, and
# TradingView's debug port listens on IPv4 ONLY. .NET/PowerShell does not do
# happy-eyeballs fallback the way Node does — it tries ::1, gets nothing, and
# sits there until the timeout expires. So the old check in START CO-PILOT.bat
#     Invoke-WebRequest -Uri 'http://localhost:9222/json/version' -TimeoutSec 2
# could NEVER succeed, no matter how ready TradingView was. It burned its full
# 2s timeout every attempt, 45 attempts, plus ~1s of PowerShell start-up each
# because it span up a fresh process per try — well over two minutes of waiting
# to reach a conclusion that was wrong anyway.
#
# Measured on this machine, in an isolated `powershell -NoProfile -File`:
#     http://localhost:9222/json/version  -> WebException: operation timed out
#     http://127.0.0.1:9222/json/version  -> OK
#
# The app itself is NOT affected: Node's fetch tries both families and connects
# in ~60ms. This was only ever a launcher problem.
$cdpUrl = "http://127.0.0.1:$Port/json/version"

function Test-Cdp {
  try {
    # Proxy explicitly disabled: a system proxy that does not except loopback
    # would reintroduce exactly this class of silent timeout.
    $r = [Net.HttpWebRequest]::Create($cdpUrl)
    $r.Proxy = $null
    $r.Timeout = 2000
    $resp = $r.GetResponse()
    $resp.Close()
    return $true
  } catch { return $false }
}

function Get-TradingViewExe {
  # 1. The package registration. Version-proof: this is what actually broke.
  #    Listing C:\Program Files\WindowsApps is ACL-denied, but the specific
  #    InstallLocation the package reports IS readable, so this works where a
  #    directory scan does not.
  try {
    $pkg = Get-AppxPackage -Name '*TradingView*' -ErrorAction SilentlyContinue |
             Sort-Object -Property Version -Descending | Select-Object -First 1
    if ($pkg -and $pkg.InstallLocation) {
      $exe = Join-Path $pkg.InstallLocation 'TradingView.exe'
      if (Test-Path $exe) { return $exe }
    }
  } catch {}

  # 2. Ordinary (non-Store) installs, for the day he reinstalls it that way.
  foreach ($p in @(
    (Join-Path $env:LOCALAPPDATA 'TradingView\TradingView.exe'),
    (Join-Path $env:ProgramFiles 'TradingView\TradingView.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'TradingView\TradingView.exe')
  )) { if ($p -and (Test-Path $p)) { return $p } }

  # 3. Anything already running tells us exactly where it lives.
  try {
    $proc = Get-CimInstance Win32_Process -Filter "Name='TradingView.exe'" -ErrorAction SilentlyContinue |
              Select-Object -First 1
    if ($proc -and $proc.ExecutablePath -and (Test-Path $proc.ExecutablePath)) { return $proc.ExecutablePath }
  } catch {}

  return $null
}

# ── already good? ───────────────────────────────────────────────────────────
if (-not $Force -and (Test-Cdp)) {
  Write-Host "      TradingView is already up with the debug port open - reusing it."
  exit 0
}

$exe = Get-TradingViewExe
if (-not $exe) {
  Write-Host ""
  Write-Host "      [X] TradingView.exe could not be found anywhere."
  Write-Host "          Looked at: the installed package registration, LOCALAPPDATA,"
  Write-Host "          Program Files, and any running TradingView process."
  Write-Host "          Is TradingView installed on this machine?"
  Write-Host "          Chart features will not work until it is."
  exit 1
}

Write-Host "      Found: $exe"

# Kill first: a TradingView started WITHOUT the flag can never be attached to,
# so if CDP is not answering, whatever is running is useless to us.
try { Get-Process TradingView -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Seconds 2

try {
  Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=$Port"
  Write-Host "      Launched with --remote-debugging-port=$Port"
} catch {
  Write-Host "      [X] Failed to launch it: $($_.Exception.Message)"
  exit 1
}

# ── poll, in THIS process ───────────────────────────────────────────────────
# Cold-start genuinely varies 20-60s+, so poll the real endpoint rather than
# guessing a fixed sleep. One process, one second apart.
$sw = [Diagnostics.Stopwatch]::StartNew()
$dots = 0
while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
  if (Test-Cdp) {
    Write-Host "      Debug port answered after $([int]$sw.Elapsed.TotalSeconds)s."
    # The port can answer before the chart UI is usable.
    Start-Sleep -Seconds 3
    exit 0
  }
  Start-Sleep -Seconds 1
  $dots++
  if ($dots % 10 -eq 0) { Write-Host "      ...still booting ($([int]$sw.Elapsed.TotalSeconds)s)" }
}

Write-Host "      [!] No answer on port $Port after ${TimeoutSec}s - continuing anyway."
Write-Host "          mcp-bridge.js will keep retrying on its own heartbeat."
exit 1
