'use strict';
// ── PROTOCOL 1: SYSTEM HEALTH (every 3 days) ───────────────────────────────
// Anoop, 2026-08-28: "diagnose the system health of the app every 3 days and
// stress test it and check if any silent turn off of any of the functions
// inside the app, notify me and impact of analyses. rectify the outcome and
// provide evidence."
//
// Protocol 2 watches the live feed — the data coming IN from TradingView.
// This one watches the APP: the parts that can stop working while the screen
// keeps looking normal.
//
// ── WHAT "SILENT TURN OFF" HAS ACTUALLY MEANT HERE ─────────────────────────
// Not one thing. Four distinct kinds, all found live in this repo, all
// invisible until someone happened to look:
//
//   1. A DEAD BUTTON. The Standard/Scalper toggle shipped 2026-08-01 and never
//      once worked: app.js referenced `ws`, which lives inside ws-client.js's
//      IIFE, so every click threw ReferenceError. It looked fine because the
//      config handler set the button state on load. A month of a discipline
//      control that could not be changed. The CONTROL toggle inherited the
//      same bug on the day it was written.
//   2. A MODULE THAT RUNS AND PRODUCES NOTHING. signal-outcome.js resolved
//      every armed signal for weeks and wrote zero rows, because the field it
//      anchors on was never populated. The timer fired, the code ran, the
//      output was empty.
//   3. A GUARD SWITCHED OFF IN CONFIG. rules.json can disable the checklist
//      gate, the loss ratchet, the contracts-per-day cap. Each is a real
//      protection, and `enabled:false` is indistinguishable from "this account
//      does not need it".
//   4. A NUMBER THAT DRIFTED. eval.start still says 150000 on an account that
//      is actually 50K, so the drawdown floor is computed against the wrong
//      base.
//
// A health check that only asks "is the process up?" catches none of these.
//
// ── SAME FOUR OBLIGATIONS AS PROTOCOL 2 ────────────────────────────────────
// verdict / impact / rectify / evidence. Unknown is never counted as a pass.
//
// PURE. The runner gathers; this decides.

const SEV = { CRITICAL: 'critical', DEGRADED: 'degraded', INFO: 'info' };

function check(key, label, verdict, opts) {
  const o = opts || {};
  return {
    key, label, verdict,
    severity: o.severity || SEV.DEGRADED,
    impact: o.impact || null,
    rectify: o.rectify || null,
    evidence: o.evidence || null,
  };
}

// Safety rules that can be switched off in rules.json. Each names what is
// EXPOSED when it is off — "requireChecklist: false" means nothing without
// the consequence attached to it.
const GUARDS = [
  { path: 'requireChecklist', label: 'Pre-trade checklist gate',
    exposes: 'A session can start with no checklist. On 2026-08-10 that was skipped and the day lost $855.50 — the reason this became a hard gate.' },
  { path: 'lossRatchet.enabled', label: 'Loss ratchet',
    exposes: "Tomorrow's max loss is no longer capped by today's profit. Targets the documented failure mode: a couple of green days, then one day that eats them." },
  { path: 'contractsPerDay.enabled', label: 'Contracts-per-day cap',
    exposes: 'Total daily contracts are uncapped. Size cap limits each ENTRY to 2, but ten legal 2-lot trades is twenty contracts — every one inside the rules, day already lost.' },
  { path: 'biasAdherence.enabled', label: 'Bias adherence tracking',
    exposes: 'Counter-bias trading is no longer measured, so the 75% adherence target cannot be reported against.' },
  { path: 'oneInstrumentPerDay', label: 'One instrument per day',
    exposes: 'MNQ and MGC can be traded the same day — present in every one of the six blown accounts.' },
];

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * @param {object} obs gathered by the runner:
 *   { deadRefs:[{file,line,text}], orphanModules:[...], timers:[{name,alive}],
 *     dataIntegrity:{days:[{day,rowsNet,ledgerNet,historyPnl,agree}]},
 *     signalPipeline:{signalsToday,armedToday,outcomesResolved,lastSignalAgeH},
 *     stress:{module,ok,error}[], diskWritable, testSuite:{pass,fail},
 *     accountConfig:{configuredStart,accountSize,brokerBalance} }
 * @param {object} rules rules.json
 */
function evaluate(obs, rules) {
  const o = obs || {};
  const r = rules || {};
  const checks = [];

  // ── 1. DEAD BUTTONS: renderer code reaching outside its scope ───────────
  const dead = Array.isArray(o.deadRefs) ? o.deadRefs : null;
  checks.push(check('dead-refs', 'No dead UI controls',
    dead == null ? 'unknown' : (dead.length ? 'fail' : 'pass'), {
      severity: SEV.CRITICAL,
      impact: dead && dead.length
        ? `${dead.length} renderer reference(s) to a variable outside their scope. Every click on those controls throws ReferenceError and does nothing — and because the button state is set from server config on load, it still LOOKS correct. This is exactly how the Standard/Scalper toggle sat dead for a month.`
        : null,
      rectify: dead && dead.length ? 'report-dead-refs' : null,
      evidence: dead ? { count: dead.length, refs: dead.slice(0, 10) } : null,
    }));

  // ── 2. MODULES THAT RUN AND PRODUCE NOTHING ─────────────────────────────
  const sp = o.signalPipeline;
  if (sp) {
    // Armed signals with no resolved outcomes is the signal-outcome.js failure
    // shape: the timer fires, the code runs, nothing is ever written.
    const producing = !(sp.armedToday > 0 && sp.outcomesResolved === 0);
    checks.push(check('signal-pipeline', 'Signal pipeline produces output',
      producing ? 'pass' : 'fail', {
        severity: SEV.CRITICAL,
        impact: producing ? null
          : `${sp.armedToday} signal(s) armed today and ZERO outcomes resolved. The resolver is running and writing nothing — the same silent failure that left signal-outcome.js producing no data for weeks while looking healthy.`,
        rectify: producing ? null : 'report-pipeline-stall',
        evidence: sp,
      }));
  }

  // ── 3. GUARDS SWITCHED OFF ──────────────────────────────────────────────
  const off = GUARDS.filter(g => getPath(r, g.path) === false);
  checks.push(check('guards', 'Safety guards enabled', off.length ? 'fail' : 'pass', {
    severity: SEV.CRITICAL,
    impact: off.length
      ? off.map(g => `${g.label} is OFF — ${g.exposes}`).join(' | ')
      : null,
    // Never auto-flipped: a guard the user turned off deliberately must not be
    // turned back on behind them. Reported every cycle instead, so "off" stays
    // a decision rather than becoming the forgotten default.
    rectify: null,
    evidence: { off: off.map(g => g.path), checked: GUARDS.map(g => g.path) },
  }));

  // ── 4. NUMBERS THAT DRIFTED ─────────────────────────────────────────────
  const ac = o.accountConfig;
  if (ac && ac.accountSize && ac.configuredStart != null) {
    const expected = { '50k': 50000, '100k': 100000, '150k': 150000 }[ac.accountSize];
    // A start balance far from the account's nominal size is either a
    // deliberate correction or drift. Either way it must be visible.
    const plausible = expected == null || Math.abs(ac.configuredStart - expected) < expected * 0.1;
    checks.push(check('account-config', 'Account configuration coherent', plausible ? 'pass' : 'fail', {
      severity: SEV.CRITICAL,
      impact: plausible ? null
        : `The configured start balance ($${ac.configuredStart}) does not match the selected ${ac.accountSize} account. The drawdown floor and profit target are both derived from it, so both are wrong by the difference.`,
      rectify: null,
      evidence: ac,
    }));
  }

  // ── 5. DATA INTEGRITY across the three stores ───────────────────────────
  const di = o.dataIntegrity;
  if (di && Array.isArray(di.days)) {
    const bad = di.days.filter(d => d.agree === false);
    checks.push(check('data-integrity', 'Rows, ledger and history agree', bad.length ? 'fail' : 'pass', {
      severity: SEV.CRITICAL,
      impact: bad.length
        ? `${bad.length} day(s) where day_trades, balance_ledger and gr_history disagree. Those three are supposed to be one fact stored three ways; when they diverge, every P&L figure depends on which one the reader happened to open.`
        : null,
      rectify: bad.length ? 'report-integrity-drift' : null,
      evidence: { checked: di.days.length, disagreeing: bad.slice(0, 5) },
    }));
  }

  // ── 6. BACKGROUND TIMERS ────────────────────────────────────────────────
  const timers = Array.isArray(o.timers) ? o.timers : null;
  if (timers) {
    const stopped = timers.filter(t => !t.alive);
    checks.push(check('timers', 'Background timers alive', stopped.length ? 'fail' : 'pass', {
      severity: SEV.DEGRADED,
      impact: stopped.length
        ? `Not running: ${stopped.map(t => t.name).join(', ')}. Each is a scheduled job whose absence is silent — nothing on screen changes when a resolver stops resolving.`
        : null,
      rectify: stopped.length ? 'restart-timers' : null,
      evidence: { total: timers.length, stopped: stopped.map(t => t.name) },
    }));
  }

  // ── 7. STRESS: do the pure decision modules survive garbage? ────────────
  // The historical failure this targets: chart-reads.js produced an EMA of
  // 65,750,116.55 from one malformed bar — a plausible-looking wrong number,
  // not an obvious NaN. Modules are fed nulls, NaNs and empty arrays and must
  // refuse rather than invent.
  const stress = Array.isArray(o.stress) ? o.stress : null;
  if (stress) {
    const broke = stress.filter(s => !s.ok);
    checks.push(check('stress', 'Modules refuse bad input safely', broke.length ? 'fail' : 'pass', {
      severity: SEV.CRITICAL,
      impact: broke.length
        ? `${broke.length} module(s) threw or returned a non-finite number on malformed input: ${broke.map(b => b.module).join(', ')}. A module that invents a number from bad data is the failure TRUST-PROTOCOL Rule 1 exists to prevent — a confident wrong read, not an obvious error.`
        : null,
      rectify: null,
      evidence: { tested: stress.length, failed: broke },
    }));
  }

  // ── 8. TEST SUITE ───────────────────────────────────────────────────────
  if (o.testSuite) {
    const ts = o.testSuite;
    checks.push(check('tests', 'Test suite green', ts.fail === 0 ? 'pass' : 'fail', {
      severity: SEV.DEGRADED,
      impact: ts.fail ? `${ts.fail} failing test(s). The suite is the only thing standing between a refactor and a live-money regression.` : null,
      rectify: null,
      evidence: ts,
    }));
  }

  // ── 9. DISK ─────────────────────────────────────────────────────────────
  if (o.diskWritable != null) {
    checks.push(check('disk', 'Data directory writable', o.diskWritable ? 'pass' : 'fail', {
      severity: SEV.CRITICAL,
      impact: o.diskWritable ? null
        : 'The data directory is not writable. Trades, signals and session state are being kept in memory only and will be lost on restart, with nothing on screen saying so.',
      rectify: null,
      evidence: { diskWritable: o.diskWritable },
    }));
  }

  return summarise(checks);
}

function summarise(checks) {
  const failures = checks.filter(c => c.verdict === 'fail');
  const unknowns = checks.filter(c => c.verdict === 'unknown');
  const critical = failures.filter(c => c.severity === SEV.CRITICAL);
  return {
    checks,
    total: checks.length,
    passed: checks.filter(c => c.verdict === 'pass').length,
    failed: failures.length,
    unknown: unknowns.length,
    critical: critical.length,
    rectifications: failures.filter(c => c.rectify).map(c => ({ key: c.key, action: c.rectify, label: c.label })),
    headline: failures.length === 0 && unknowns.length === 0
      ? 'System health verified — all checks passed.'
      : `${failures.length} failing, ${unknowns.length} unverifiable, ${critical.length} critical.`,
  };
}

// Has three days elapsed? Kept pure and separate so the cadence is testable
// without waiting three days.
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
function isDue(lastRunMs, nowMs, intervalMs) {
  const iv = Number.isFinite(intervalMs) ? intervalMs : THREE_DAYS_MS;
  if (!Number.isFinite(lastRunMs) || lastRunMs <= 0) return true;   // never run
  return (nowMs - lastRunMs) >= iv;
}

module.exports = { evaluate, summarise, isDue, GUARDS, SEV, THREE_DAYS_MS };
