'use strict';
// ── econ-calendar.js — scheduled US data releases as a trading blackout ─────
//
//   node cli/econ-calendar.js            # next 7 days
//   node cli/econ-calendar.js --days 14
//   node cli/econ-calendar.js --check    # is RIGHT NOW inside a blackout?
//
// ── WHY THIS IS A BRAKE, NOT A SIGNAL ──────────────────────────────────────
// The pre-session brief already detects violence after the fact: on its first
// run it independently flagged the largest overnight move in BOTH instruments
// at 08:30 ET on Friday 4 September 2026 — MNQ -114 pts (5.2 sigma), MGC -77.4
// pts (21.1 sigma). First Friday of the month, at the canonical US release
// time. That was Non-Farm Payrolls, found with no calendar wired at all.
//
// Detecting it afterwards is not the useful half. This module answers the
// question the brief could not: is something like that SCHEDULED, and how many
// minutes away is it.
//
// It only ever produces a REFUSAL. There is no field here that says a release
// is bullish, no expected direction, and no "trade the number" mode. Consensus
// versus actual is deliberately not surfaced pre-release, because a consensus
// figure in front of someone before a print is a prediction prompt.
//
// ── FAIL CLOSED ────────────────────────────────────────────────────────────
// If the calendar cannot be reached, the answer is BLOCKED, not "proceed".
// A guard that opens when its data source breaks is not a guard. `blocked` is
// therefore true whenever the answer is unknown, and `reason` says which kind
// of unknown it was so a caller can tell a missing key from a dead network.
//
// ── HOT PATH ───────────────────────────────────────────────────────────────
// Never call fetchCalendar() from a trade decision. Refresh it on a timer,
// hold the windows in memory, and evaluate isBlackout() — which is pure — at
// decision time. A network call inside handleTradeConfirm would add a failure
// mode to the one code path that places real orders.

const { run } = require('./market-cli');
const Y = require('./yahoo');

// The releases that actually move MNQ and MGC, with the ET clock time each is
// published at. FRED gives the DATE of a release but not its time of day, so
// the time comes from the publishing agency's fixed schedule — BLS and BEA
// have released at 08:30 ET for decades; FOMC statements land at 14:00 ET.
//
// `blackoutBefore`/`blackoutAfter` are minutes around the print. The asymmetry
// is deliberate: the minutes before are about not being positioned into a coin
// flip, the minutes after are about not chasing the spike — and the spike is
// where the damage in this repo's own history gets done.
const RELEASES = [
  { match: /employment situation|nonfarm|payroll/i, key: 'NFP', etHour: 8, etMin: 30, before: 30, after: 60, tier: 1 },
  { match: /consumer price index/i, key: 'CPI', etHour: 8, etMin: 30, before: 30, after: 60, tier: 1 },
  { match: /producer price index/i, key: 'PPI', etHour: 8, etMin: 30, before: 20, after: 30, tier: 2 },
  { match: /FOMC|federal open market/i, key: 'FOMC', etHour: 14, etMin: 0, before: 45, after: 90, tier: 1 },
  { match: /gross domestic product/i, key: 'GDP', etHour: 8, etMin: 30, before: 20, after: 30, tier: 2 },
  { match: /personal income and outlays|PCE/i, key: 'PCE', etHour: 8, etMin: 30, before: 20, after: 30, tier: 2 },
  { match: /retail sales/i, key: 'RETAIL', etHour: 8, etMin: 30, before: 15, after: 30, tier: 3 },
  { match: /jobless claims|unemployment insurance/i, key: 'CLAIMS', etHour: 8, etMin: 30, before: 10, after: 20, tier: 3 },

  // ── G27 (2026-09-09): the same feed carries more movers than these eight ──
  // Each entry's `match` is the EXACT release_name FRED reports (verified via
  // `fred release list` and `node cli/econ-calendar.js --days 14`, not guessed),
  // and each time is the publishing agency's fixed ET schedule — FRED gives the
  // DATE only, never the time of day.
  //
  // NOT in this list, deliberately, because FRED carries NO release for them
  // (verified, not an oversight): ISM Manufacturing PMI and ISM Services PMI
  // (Institute for Supply Management — private, not a FRED release), Conference
  // Board Consumer Confidence (private), and FOMC Minutes as a release separate
  // from the statement (FRED has only "FOMC Press Release" and the unrelated
  // "Discount Rate Meeting Minutes"). A regex for a name FRED never emits is
  // dead code that LOOKS like coverage — worse than an honest gap.
  //
  // Tier calibration against the existing entries (GDP/PCE tier 2 = 20/30,
  // RETAIL tier 3 = 15/30, CLAIMS tier 3 = 10/20). Industrial production,
  // housing starts and durable goods are growth/rate-sensitive like GDP/PCE but
  // react smaller and fade faster than NFP/CPI (tier 1), so they are tier 2.
  // The regional Fed surveys (Empire State, Philly Fed) are early-signal,
  // single-region reads — real but small — so tier 3, the CLAIMS band.
  { match: /industrial production|capacity utilization/i, key: 'INDPROD', etHour: 9, etMin: 15, before: 15, after: 30, tier: 2 },  // Federal Reserve, 09:15 ET
  { match: /new residential construction/i, key: 'HOUSING', etHour: 8, etMin: 30, before: 15, after: 30, tier: 2 },               // Census — housing starts + building permits, 08:30 ET
  { match: /manufacturer's shipments, inventories, and orders|durable goods/i, key: 'DURABLE', etHour: 8, etMin: 30, before: 20, after: 30, tier: 2 },  // Census durable-goods orders, 08:30 ET
  { match: /surveys of consumers/i, key: 'MICH', etHour: 10, etMin: 0, before: 15, after: 30, tier: 2 },                            // U. Michigan sentiment, 10:00 ET
  { match: /empire state manufacturing/i, key: 'EMPIRE', etHour: 8, etMin: 30, before: 10, after: 20, tier: 3 },                    // NY Fed Empire State, 08:30 ET
  { match: /^manufacturing business outlook/i, key: 'PHILLY', etHour: 8, etMin: 30, before: 10, after: 20, tier: 3 },              // Philly Fed manufacturing, 08:30 ET (^ excludes the Nonmanufacturing services survey)
];

function classify(releaseName) {
  for (const r of RELEASES) if (r.match.test(releaseName)) return r;
  return null;
}

// ── fetchCalendar ──────────────────────────────────────────────────────────
// Returns { ok, windows, reason }. `windows` are absolute epoch-second spans
// with the release that produced them attached.
async function fetchCalendar({ days = 7 } = {}) {
  // --limit must exceed the release-dates in the window or the calendar is
  // silently truncated to the FIRST N rows — which, ordered by date ascending,
  // are all in the PAST, so a truncated calendar can never see an upcoming
  // blackout. ~27 releases/day, so the CLI default of 100 is ~2.5 days of past
  // rows. 1000 is the FRED API's hard maximum ("Variable limit is not between
  // 1 and 1000"), which covers ±18 days; beyond that the calendar truncates on
  // the FRED side, not ours. The app queries ±7 (default) to ±14 days, well
  // inside that. G27 fix, found while wiring the wider blackout list.
  const res = await run('fred', ['release', 'calendar', '--days', String(days), '--limit', '1000']);

  if (!res.ok) {
    const reason = res.codeKey === 'auth' || res.codeKey === 'config'
      ? 'FRED_API_KEY is not set. Get a free key at '
        + 'https://fredaccount.stlouisfed.org/apikeys then: setx FRED_API_KEY <key>'
      : (res.error || 'calendar unreachable');
    return { ok: false, windows: [], reason, code: res.codeKey };
  }

  // The `release calendar` command returns `{ ..., releases: [...] }` (not
  // `release_dates`, which is `release dates`' shape). Reading the wrong key
  // returned an empty list on every live run — the calendar looked healthy
  // while seeing nothing. G27 fix.
  const rows = Array.isArray(res.data) ? res.data
    : (res.data && Array.isArray(res.data.releases) ? res.data.releases : []);

  const windows = [];
  for (const row of rows) {
    const name = row.release_name || row.name || '';
    const date = row.date || row.release_date;
    if (!name || !date) continue;
    const spec = classify(name);
    if (!spec) continue; // only the releases that move these two instruments

    const at = etEpochFor(date, spec.etHour, spec.etMin);
    if (at == null) continue;
    windows.push({
      key: spec.key, name, date, tier: spec.tier,
      at, atLabel: Y.fmtBoth(at),
      from: at - spec.before * 60,
      to: at + spec.after * 60,
      beforeMin: spec.before, afterMin: spec.after,
    });
  }
  windows.sort((a, b) => a.at - b.at);
  return { ok: true, windows, reason: null };
}

// Convert "YYYY-MM-DD" plus an ET wall-clock time into an epoch second.
// Solved by probing rather than by adding a fixed offset, because the ET
// offset changes twice a year — the same class of bug already recorded against
// this repo's IST session windows.
function etEpochFor(dateStr, etHour, etMin) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr).trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  // Start from the UTC instant with the same wall clock, then correct by the
  // difference between what New York reads there and what we wanted.
  let guess = Date.UTC(+y, +mo - 1, +d, etHour, etMin) / 1000;
  for (let i = 0; i < 3; i++) {
    const p = Y.etParts(guess);
    const deltaMin = (etHour * 60 + etMin) - p.minutes;
    if (deltaMin === 0 && p.d === +d) break;
    guess += deltaMin * 60;
  }
  return Math.floor(guess);
}

// ── isBlackout — PURE. This is what a decision path calls. ─────────────────
function isBlackout(windows, nowSec = Math.floor(Date.now() / 1000)) {
  if (!Array.isArray(windows)) {
    return { blocked: true, reason: 'no calendar loaded — failing closed', window: null };
  }
  for (const w of windows) {
    if (nowSec >= w.from && nowSec <= w.to) {
      const mins = Math.round((w.at - nowSec) / 60);
      return {
        blocked: true, window: w,
        reason: mins > 0
          ? w.key + ' (' + w.name + ') releases in ' + mins + ' minutes at ' + w.atLabel
          : w.key + ' released ' + Math.abs(mins) + ' minutes ago at ' + w.atLabel,
      };
    }
  }
  const next = windows.find((w) => w.from > nowSec);
  return {
    blocked: false, window: null,
    next: next ? { key: next.key, at: next.atLabel, inMinutes: Math.round((next.from - nowSec) / 60) } : null,
    reason: null,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--days');
  const days = i >= 0 ? parseInt(argv[i + 1], 10) : 7;

  const cal = await fetchCalendar({ days });

  if (!cal.ok) {
    console.log('\n  ECON CALENDAR — UNAVAILABLE (failing closed)');
    console.log('  ' + cal.reason + '\n');
    process.exitCode = 1;
    return;
  }

  if (argv.includes('--check')) {
    const v = isBlackout(cal.windows);
    console.log(JSON.stringify(v, null, 2));
    return;
  }

  console.log('\n  ECON CALENDAR — next ' + days + ' days, releases that move MNQ/MGC');
  console.log('  ' + '─'.repeat(64));
  if (!cal.windows.length) {
    console.log('  none scheduled in this window');
  }
  for (const w of cal.windows) {
    console.log('  ' + w.key.padEnd(8) + w.atLabel.padEnd(26)
      + 'blackout -' + w.beforeMin + 'm / +' + w.afterMin + 'm   ' + w.name);
  }
  const v = isBlackout(cal.windows);
  console.log('  ' + '─'.repeat(64));
  console.log('  RIGHT NOW: ' + (v.blocked ? 'BLOCKED — ' + v.reason
    : 'clear' + (v.next ? ' — next is ' + v.next.key + ' in ' + v.next.inMinutes + ' min' : '')));
  console.log('');
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}

module.exports = { fetchCalendar, isBlackout, classify, etEpochFor, RELEASES };
