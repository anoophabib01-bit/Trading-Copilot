// ── Checklist pure logic (2026-08-13) ─────────────────────────────────────────
// Extracted from renderer/app.js so the pieces that decide whether Anoop can
// trade are testable without a DOM. Same dual-export shape as loss-ratchet.js
// and volume-budget.js: node `require` for tests, `window.*` for the renderer,
// one copy so what is tested is what runs.
//
// Why this file exists at all — three defects found on 2026-08-13 that all live
// in logic previously trapped inside DOM handlers:
//
//   1. ckPlanRead() called itself (infinite recursion, caught, returned {}),
//      silently discarding every tick for 19 days.
//   2. The score total was computed TWICE with different formulas:
//        ckUpdateVerdict  total = 3 + structTotal + 4          + 5   (risk hardcoded 4)
//        ckMarkDone       total = 3 + structTotal + riskTotal   + 5   (risk from DOM)
//      Add or remove one Risk Gate item in index.html and the on-screen verdict
//      disagrees with the score written to the permanent record.
//   3. Three different "what day is it" functions disagree:
//        ckToday()  → browser-local Y-M-D
//        edToday()  → forced Asia/Kolkata
//        go/no-go   → new Date().toISOString() (UTC)
//      Between 00:00 and 05:30 IST those produce different day keys, so a
//      checklist completed at 01:00 IST would not satisfy a gate reading UTC.
//
// SCORING/DAY LOGIC BELONGS HERE. Do not re-implement it in a DOM handler.

// ── Trading day ───────────────────────────────────────────────────────────────
// ONE definition of "today", in IST, matching the rest of the app's convention
// (CLAUDE.md: "Timestamps/session windows are IST wall-clock").
//
// CHANGED 2026-08-15 (Anoop): rolls over at 03:30 IST, not midnight. He found
// the gate unlocked on a day he had not touched the checklist — a completion
// logged late the previous night (after midnight, before he was actually done
// for the night) satisfied the calendar-day match for "today" the moment the
// clock crossed 00:00, hours before he ever sat down for a new session. A
// checklist done at 01:00 IST still belongs to the PREVIOUS session in his
// head, same as trade records already treat 00:00-03:30 IST as "still last
// night" (see tradingDayStampIST() in server.js, which rolls at 03:45 for the
// Globex maintenance break — this is the same idea, just a slightly earlier,
// checklist-specific cutoff he asked for explicitly).
function tradingDayIST(nowMs) {
  const IST_OFF = 330 * 60 * 1000;
  const ist = new Date((nowMs != null ? nowMs : Date.now()) + IST_OFF);
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (mins < 3 * 60 + 30) ist.setUTCDate(ist.getUTCDate() - 1);
  return ist.toISOString().slice(0, 10);
}

// ── Session detection ─────────────────────────────────────────────────────────
// London 08:00-09:30 UTC (13:30-15:00 IST), NY 13:30-15:30 UTC (19:00-21:00 IST)
// per CLAUDE.md rule #6. Returns '' outside those windows AND on Sat/Sun — the
// old ckSessFromUTC() happily reported 'ny' on a Saturday and told him to start
// a screen recording for a market that is shut.
function sessionFromUTC(nowMs) {
  const now = new Date(nowMs != null ? nowMs : Date.now());
  const dow = now.getUTCDay(); // 0 Sun .. 6 Sat
  if (dow === 0 || dow === 6) return '';
  const tot = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (tot >= 480 && tot < 570) return 'london';
  if (tot >= 810 && tot < 930) return 'ny';
  return '';
}

// Weekends: the daily gate must not fire (no market to be disciplined about).
// Uses the same 03:30 IST rollover as tradingDayIST() so 2am Saturday still
// reads as Friday night, not a weekend that never actually traded.
function isWeekendIST(nowMs) {
  const day = tradingDayIST(nowMs);
  const dow = new Date(day + 'T00:00:00Z').getUTCDay();
  return dow === 0 || dow === 6;
}

// ISO week key for the weekend screen-time log, e.g. "2026-W33". Kept in its
// own storage key rather than inside the daily plan blob so a Saturday entry
// can never collide with a gating record.
function isoWeekKey(nowMs) {
  const IST_OFF = 330 * 60 * 1000;
  const d = new Date((nowMs != null ? nowMs : Date.now()) + IST_OFF);
  d.setUTCHours(0, 0, 0, 0);
  // Thursday of the current ISO week determines the year.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return d.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

// ── Scoring ───────────────────────────────────────────────────────────────────
// The single source of truth for readiness score + tier. Callers pass counts,
// not DOM nodes.
//
// riskFull is a HARD gate: any missing Risk Gate item is NO-GO regardless of
// score. riskTotal === 0 therefore yields NO-GO, which is load-bearing — an
// empty//broken Risk Gate block must never read as "cleared".
const PLAYBOOKS = {
  1: { label: 'Engulfing + TF', structTotal: 3 },
  2: { label: 'SFP + FVG', structTotal: 4 },
  3: { label: 'Liquidity Raid', structTotal: 2 }
};

function ckScore(inp) {
  inp = inp || {};
  const selPb = inp.selPb;
  const pb = PLAYBOOKS[selPb];
  const htfDone = inp.htfDone || 0;
  const structDone = inp.structDone || 0;
  const riskDone = inp.riskDone || 0;
  const riskTotal = inp.riskTotal || 0;
  const fwDone = inp.fwDone || 0;
  const structTotal = pb ? pb.structTotal : 0;
  const label = pb ? pb.label : '';

  const done = htfDone + structDone + riskDone + fwDone;
  const total = 3 + structTotal + riskTotal + 5;
  const score = (pb && total) ? Math.round((done / total) * 10) : 0;
  const riskFull = riskTotal > 0 && riskDone === riskTotal;

  let tier, verdict;
  if (inp.blackout) {
    tier = 'NO-GO';
    verdict = 'High-impact news blackout — no entries until the window clears.';
  } else if (!pb) {
    tier = 'NO-GO';
    verdict = 'No playbook selected — pick one before scoring.';
  } else if (!riskFull) {
    tier = 'NO-GO';
    verdict = 'Risk Gate incomplete (' + riskDone + '/' + riskTotal + ') — do NOT trade until every risk item is checked.';
  } else if (score >= 8) {
    tier = 'GO';
    verdict = 'High-conviction ' + label + ' setup. Size per rules, one of your planned trades, hold it 5+ min.';
  } else if (score >= 5) {
    tier = 'CAUTION';
    verdict = 'Partial ' + label + ' setup — only trade if the missing items are non-essential; otherwise wait.';
  } else {
    tier = 'NO-GO';
    verdict = 'Too few conditions met — this is not a setup. Stand down.';
  }
  return { score: score, tier: tier, label: label, done: done, total: total, riskFull: riskFull, verdict: verdict };
}

// ── Gate predicate ────────────────────────────────────────────────────────────
// Decided 2026-08-13 (Anoop): completing the checklist and getting a NO-GO is a
// SUCCESS — the gate opens on completion, not on verdict. Gating on GO would
// hand him a direct incentive to tick items he never verified, which turns the
// permanent record into fiction. The NO-GO still shows everywhere; it just does
// not hold his app hostage.
//
// SKIPPED counts as "gate open" too — Skip is the deliberate escape hatch. It
// is recorded, it breaks the streak, and it paints a banner, but it does not
// leave him locked out.
//
// Fails OPEN on anything malformed. This inverts the fail-closed choice the
// go/no-go badge makes, and that is intentional: the badge only ADVISES, so
// erring toward NO-GO is free. This predicate controls access to his own tool
// during a live session, so a corrupt localStorage value must never be able to
// lock him out of it.
function ckGateOpen(ckHistory, todayStr) {
  try {
    if (!Array.isArray(ckHistory)) return true; // unreadable → fail open
    if (!todayStr) return true;
    return ckHistory.some(function (e) {
      return e && e.date === todayStr && (e.done === true || e.tier === 'SKIPPED' || e.tier != null);
    });
  } catch (e) {
    return true;
  }
}

// Streak of consecutive days with a completed (not skipped) checklist, counting
// back from today. The one psychological object worth building here: he has
// zero completions, and a counter that starts at 1 and grows is the cheapest
// reward available on top of a record we already keep.
// Weekends are SKIPPED OVER, not counted and not breaking — there is no market.
function ckStreak(ckHistory, todayStr, nowMs) {
  if (!Array.isArray(ckHistory) || !todayStr) return 0;
  const byDate = {};
  ckHistory.forEach(function (e) { if (e && e.date) byDate[e.date] = e; });
  let streak = 0;
  const cur = new Date(todayStr + 'T00:00:00Z');
  for (let i = 0; i < 400; i++) {
    const key = cur.toISOString().slice(0, 10);
    const dow = cur.getUTCDay();
    if (dow === 0 || dow === 6) { cur.setUTCDate(cur.getUTCDate() - 1); continue; }
    const e = byDate[key];
    if (e && e.tier !== 'SKIPPED') streak++;
    else if (i === 0) { /* today not done yet — don't break the streak */ }
    else break;
    cur.setUTCDate(cur.getUTCDate() - 1);
  }
  return streak;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { tradingDayIST, sessionFromUTC, isWeekendIST, isoWeekKey, ckScore, ckGateOpen, ckStreak, PLAYBOOKS };
}
if (typeof window !== 'undefined') {
  window.ChecklistLogic = { tradingDayIST, sessionFromUTC, isWeekendIST, isoWeekKey, ckScore, ckGateOpen, ckStreak, PLAYBOOKS };
}
