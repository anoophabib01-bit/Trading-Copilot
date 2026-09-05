'use strict';
/* ── failure-chain.js — HOW the day failed, not how many rules it broke ──────
 * 2026-09-03. Anoop, on the Judge: "as the judge always describes the mismatch
 * between platforms and not real solution to the problem i want this loop to
 * really give the core reason for the failure."
 *
 * He is right, and it is a data problem rather than a tone problem.
 *
 * WHAT EVERY AGENT IN THIS APP IS HANDED TODAY
 * -------------------------------------------
 * Aggregates. gr_history gives counts (over: 4, revenge: 1, disc: 75). The
 * pattern ledger gives recurrence (64 oversizes across 18 days). app_get_data
 * "trades" gives a flat list. Every one of those answers "WHAT rules did today
 * break", and none of them answers "WHY did this day end at -$2,296".
 *
 * So when an agent is asked for a cause and has only counts, it reaches for the
 * most concrete discrepancy in front of it — which is usually the
 * app-vs-broker reconciliation gap. That is why the Judge keeps opening with
 * "the app says 6 trades and 47 contracts, the broker says 4 and 41". That
 * sentence is TRUE and it is not a cause. It is a caveat about measurement,
 * and presenting it as the finding is how a real diagnosis gets crowded out.
 *
 * THE MISSING INPUT IS THE SEQUENCE
 * ---------------------------------
 * A trading day is a causal chain, not a bag of trades. On 2026-09-03 the bag
 * says "4 oversize, 1 revenge". The chain says something completely different:
 *
 *   2 lots  +9.2    held 118s     <- the plan, working
 *   4 lots  -1.6    held 16s
 *   2 lots  +1.2    held 2134s
 *   4 lots  -526.1  held 120s     <- the first real loss
 *   15 lots -61     held 37s      <- size x3.75 immediately after it
 *   20 lots -1718   held 14s      <- 75% of the day's damage, in 14 seconds
 *
 * The cause is not "he was oversized four times". It is that ONE loss at trade
 * 4 turned a 2-4 lot session into a 20-lot session inside two trades, and the
 * holds collapsed from minutes to seconds — he stopped trading and started
 * reacting. That is a sentence he can act on. "You breached the size cap" is
 * not, because he already knows.
 *
 * This module reconstructs that chain and ranks the candidate causes BY THE
 * DOLLARS EACH ONE ACTUALLY EXPLAINS, so the agent argues from an attribution
 * rather than picking whichever violation it noticed first.
 *
 * ATTRIBUTION IS EXCLUSIVE, DELIBERATELY
 * --------------------------------------
 * Same doctrine as week-rollup.js's loss attribution, and for the same reason:
 * causes overlap (the 20-lot was oversize AND escalation AND the concentration
 * point), so summing per-cause damage double-counts and every cause then looks
 * like it explains the whole day. Each losing trade is assigned to exactly ONE
 * cause, by a fixed precedence, and a cause's damage is the sum of the trades
 * it owns. The numbers add up to the day.
 *
 * PURE. No fs, no clock, no app state — `nowMs` and `rules` are passed in.
 */

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// ── The chain ───────────────────────────────────────────────────────────────
/**
 * Order a day's trades and annotate each with what it inherited from the one
 * before: the gap since the previous exit, the size change, and where the day
 * stood when it was taken. `runningPnl` is what makes a giveback visible.
 *
 * @param {Array} trades day_trades rows {t,x,size,pnl,side,hold,flags,ep,xp}
 */
function buildChain(trades) {
  const rows = (Array.isArray(trades) ? trades : [])
    .filter(Boolean)
    .slice()
    .sort((a, b) => (num(a.t) || num(a.x)) - (num(b.t) || num(b.x)));

  let running = 0;
  let peak = 0;
  let peakAt = -1;
  let consecLosses = 0;

  return rows.map((t, i) => {
    const prev = i > 0 ? rows[i - 1] : null;
    const pnl = num(t.pnl);
    const before = running;
    running = Math.round((running + pnl) * 100) / 100;
    if (running > peak) { peak = running; peakAt = i; }
    const prevPnl = prev ? num(prev.pnl) : null;
    if (pnl < 0) consecLosses += 1; else consecLosses = 0;

    // Exit-to-entry gap. Uses the previous EXIT because that is the moment the
    // cooldown starts; entry-to-entry would count the hold as cooling off.
    const gapSec = (prev && num(prev.x) && num(t.t))
      ? Math.max(0, Math.round((num(t.t) - num(prev.x)) / 1000))
      : null;

    return {
      index: i,
      n: i + 1,
      entryMs: num(t.t) || null,
      exitMs: num(t.x) || null,
      size: num(t.size),
      pnl,
      side: t.side || null,
      hold: t.hold != null ? num(t.hold) : null,
      flags: Array.isArray(t.flags) ? t.flags.slice() : [],
      entryPrice: t.ep != null ? num(t.ep) : null,
      exitPrice: t.xp != null ? num(t.xp) : null,
      gapSec,
      pnlBefore: before,
      runningPnl: running,
      // The two facts that make escalation legible.
      sizeChange: prev ? num(t.size) - num(prev.size) : 0,
      afterLoss: prevPnl != null && prevPnl < 0,
      consecLossesAfter: consecLosses,
      isPeak: false,           // stamped below
      peakSoFar: peak,
    };
  }).map((step, i, all) => {
    if (i === peakAt && peak > 0) step.isPeak = true;
    step.dayEnd = all.length ? all[all.length - 1].runningPnl : 0;
    return step;
  });
}

// ── Turning point ───────────────────────────────────────────────────────────
/**
 * The trade after which the day changed character. Not simply the biggest
 * loser: it is the first trade that was followed by a MATERIAL escalation in
 * size, because that is the moment the plan stopped being the thing being
 * executed. Falls back to the equity peak, then to the worst trade.
 */
function findTurningPoint(chain, opts) {
  const factor = (opts && opts.escalationFactor) || 1.5;
  if (!chain || !chain.length) return null;

  for (let i = 0; i < chain.length - 1; i++) {
    const here = chain[i];
    const next = chain[i + 1];
    if (here.pnl < 0 && here.size > 0 && next.size >= here.size * factor) {
      return {
        index: i,
        kind: 'escalation-after-loss',
        why: `trade ${here.n} lost ${money(here.pnl)} and trade ${next.n} went from ${here.size} to ${next.size} contracts`,
      };
    }
  }
  const peak = chain.find((s) => s.isPeak);
  if (peak && peak.index < chain.length - 1 && chain[chain.length - 1].runningPnl < peak.runningPnl) {
    return { index: peak.index, kind: 'peak-then-giveback', why: `the day peaked at ${money(peak.peakSoFar)} on trade ${peak.n} and finished ${money(chain[chain.length - 1].runningPnl)}` };
  }
  const worst = chain.reduce((w, s) => (s.pnl < (w ? w.pnl : 0) ? s : w), null);
  if (worst && worst.pnl < 0) {
    return { index: worst.index, kind: 'single-worst', why: `trade ${worst.n} lost ${money(worst.pnl)}, the day's largest` };
  }
  return null;
}

function money(n) {
  const v = num(n);
  return (v < 0 ? '-$' : '$') + Math.abs(Math.round(v * 100) / 100).toLocaleString('en-US');
}

// ── Causes ──────────────────────────────────────────────────────────────────
// Ordered by precedence. A losing trade is attributed to the FIRST cause here
// that claims it, so the dollars never double-count. Precedence is by how
// upstream the behaviour is: escalating after a loss is a decision that
// creates the exposure; breaching the cap is the size that decision chose;
// reacting inside seconds is the state it was made in.
const CAUSES = [
  {
    id: 'size-escalation-after-loss',
    label: 'sizing up immediately after a loss',
    claims: (s, ctx) => s.afterLoss && s.sizeChange > 0 && s.pnl < 0,
    fix: 'the size for the next trade is decided BEFORE the current one closes, and a loss cannot raise it',
  },
  {
    id: 'reaction-not-decision',
    label: 'trades taken in seconds, not decided',
    claims: (s, ctx) => s.pnl < 0 && s.hold != null && s.hold <= ctx.reactionHoldSec && s.index > 0,
    fix: 'a minimum time between the setup appearing and the order going in — if it cannot survive 60 seconds of looking at it, it was a reaction',
  },
  {
    id: 'over-cap',
    label: 'trading above the size cap',
    claims: (s, ctx) => s.pnl < 0 && ctx.sizeCap > 0 && s.size > ctx.sizeCap,
    fix: 'the cap is enforced at the platform, not remembered at the moment of entry',
  },
  {
    id: 'cooldown-breach',
    label: 're-entering before the cooldown was up',
    claims: (s, ctx) => s.pnl < 0 && s.gapSec != null && ctx.cooldownSec > 0 && s.gapSec < ctx.cooldownSec && s.afterLoss,
    fix: 'the platform closes for the cooldown, rather than the cooldown being a number to respect',
  },
  {
    id: 'traded-past-stop',
    label: 'kept trading after the day was already lost',
    claims: (s, ctx) => s.pnl < 0 && ctx.dayStop > 0 && Math.abs(s.pnlBefore) >= ctx.dayStop && s.pnlBefore < 0,
    fix: 'the day stop ends the session automatically instead of being a line to notice',
  },
  {
    id: 'ordinary-loss',
    label: 'a loss taken inside the rules',
    claims: (s) => s.pnl < 0,
    fix: null,   // not a failure — this is the cost of doing business
  },
];

/**
 * Attribute every losing trade to exactly one cause and rank by dollars.
 *
 * @param {Array}  chain   buildChain() output
 * @param {object} opts    { sizeCap, cooldownMinutes, dayStop, reactionHoldSec }
 */
function attribute(chain, opts) {
  const ctx = {
    sizeCap: num(opts && opts.sizeCap),
    cooldownSec: num(opts && opts.cooldownMinutes) * 60,
    dayStop: Math.abs(num(opts && opts.dayStop)),
    // Below this, a losing trade was not a decision that had time to be one.
    // 60s is deliberately generous: the point is to catch 14-second reactions,
    // not to call a fast scalp a failure.
    reactionHoldSec: num(opts && opts.reactionHoldSec) || 60,
  };

  const byCause = new Map();
  (chain || []).forEach((s) => {
    if (s.pnl >= 0) return;
    const cause = CAUSES.find((c) => c.claims(s, ctx)) || CAUSES[CAUSES.length - 1];
    if (!byCause.has(cause.id)) byCause.set(cause.id, { id: cause.id, label: cause.label, fix: cause.fix, damage: 0, trades: [] });
    const rec = byCause.get(cause.id);
    rec.damage = Math.round((rec.damage + s.pnl) * 100) / 100;
    rec.trades.push(s.n);
  });

  const totalLoss = (chain || []).reduce((sum, s) => sum + (s.pnl < 0 ? s.pnl : 0), 0);
  return Array.from(byCause.values())
    .map((c) => Object.assign(c, {
      shareOfLoss: totalLoss ? Math.round((c.damage / totalLoss) * 100) : 0,
    }))
    .sort((a, b) => a.damage - b.damage);   // most negative first
}

/**
 * How concentrated the damage was. A day where one trade is most of the loss
 * is a different problem from a day that bled evenly, and the advice differs:
 * the first is a single decision to prevent, the second is a session to end.
 */
function concentration(chain) {
  const losses = (chain || []).filter((s) => s.pnl < 0);
  if (!losses.length) return null;
  const total = losses.reduce((s, x) => s + x.pnl, 0);
  const worst = losses.reduce((w, x) => (x.pnl < w.pnl ? x : w), losses[0]);
  return {
    worstTrade: worst.n,
    worstPnl: worst.pnl,
    worstSize: worst.size,
    worstHold: worst.hold,
    totalLoss: Math.round(total * 100) / 100,
    share: total ? Math.round((worst.pnl / total) * 100) : 0,
  };
}

/** Did the holds collapse? Reacting looks like this and counting does not show it. */
function holdCollapse(chain) {
  const held = (chain || []).filter((s) => s.hold != null && s.hold > 0);
  if (held.length < 4) return null;
  const half = Math.floor(held.length / 2);
  const med = (arr) => {
    const a = arr.map((s) => s.hold).sort((x, y) => x - y);
    return a.length % 2 ? a[(a.length - 1) / 2] : Math.round((a[a.length / 2 - 1] + a[a.length / 2]) / 2);
  };
  const first = med(held.slice(0, half));
  const last = med(held.slice(half));
  return { firstHalfMedian: first, secondHalfMedian: last, collapsed: last > 0 && first > 0 && last <= first / 3 };
}

/** One side all day while losing means no re-assessment ever happened. */
function directionPersistence(chain) {
  const sided = (chain || []).filter((s) => s.side);
  if (sided.length < 3) return null;
  const sides = new Set(sided.map((s) => String(s.side).toUpperCase()));
  const net = sided.reduce((s, x) => s + x.pnl, 0);
  return {
    sides: Array.from(sides),
    oneWay: sides.size === 1,
    side: sides.size === 1 ? Array.from(sides)[0] : null,
    trades: sided.length,
    net: Math.round(net * 100) / 100,
    // The damning case: same direction every time AND it lost.
    persistedIntoLoss: sides.size === 1 && net < 0,
  };
}

/**
 * The whole diagnosis. This is the object the agent reasons from — every
 * field is measured, and `primary` is the cause that owns the most dollars.
 */
function diagnose(trades, opts) {
  const chain = buildChain(trades);
  if (!chain.length) {
    return { chain: [], causes: [], primary: null, turningPoint: null, concentration: null, holds: null, direction: null, empty: true };
  }
  const causes = attribute(chain, opts || {});
  // A day whose only cause is "a loss taken inside the rules" HAS NO FAILURE.
  // Saying otherwise is how an app teaches that following the rules is also
  // punished — the same reasoning behind pattern-memory's `disciplined-loss`.
  const failing = causes.filter((c) => c.id !== 'ordinary-loss');
  return {
    chain,
    causes,
    primary: failing.length ? failing[0] : null,
    cleanLosses: causes.find((c) => c.id === 'ordinary-loss') || null,
    turningPoint: findTurningPoint(chain, opts),
    concentration: concentration(chain),
    holds: holdCollapse(chain),
    direction: directionPersistence(chain),
    dayEnd: chain[chain.length - 1].runningPnl,
    peak: Math.max(0, ...chain.map((s) => s.peakSoFar)),
    empty: false,
  };
}

// ── Rendering ───────────────────────────────────────────────────────────────
function formatChain(chain) {
  if (!chain || !chain.length) return 'No trades to sequence.';
  const out = ['THE SEQUENCE (this is the causal chain, read it in order):'];
  chain.forEach((s) => {
    const bits = [
      `#${s.n}`,
      `${s.size} lot${s.size === 1 ? '' : 's'}`,
      s.side || '?',
      money(s.pnl),
      s.hold != null ? `held ${s.hold}s` : 'hold unknown',
      s.gapSec != null ? `${s.gapSec}s after the previous exit` : null,
      `day running ${money(s.runningPnl)}`,
      s.flags.length ? `[${s.flags.join(', ')}]` : null,
      s.isPeak ? '<- day peaked here' : null,
    ].filter(Boolean);
    out.push('  ' + bits.join(' · '));
  });
  return out.join('\n');
}

function formatDiagnosis(d) {
  if (!d || d.empty) return 'No trades on record for this day — nothing to diagnose.';
  const out = [];
  out.push(formatChain(d.chain));

  if (d.turningPoint) {
    out.push(`\nTURNING POINT: trade ${d.chain[d.turningPoint.index].n} — ${d.turningPoint.why} (${d.turningPoint.kind}).`);
  }
  if (d.concentration) {
    out.push(`DAMAGE CONCENTRATION: trade ${d.concentration.worstTrade} alone is ${d.concentration.share}% of the day's loss `
      + `(${money(d.concentration.worstPnl)} of ${money(d.concentration.totalLoss)}) at ${d.concentration.worstSize} contracts`
      + (d.concentration.worstHold != null ? `, held ${d.concentration.worstHold}s.` : '.'));
  }
  if (d.holds && d.holds.collapsed) {
    out.push(`HOLD COLLAPSE: median hold fell from ${d.holds.firstHalfMedian}s in the first half of the day to ${d.holds.secondHalfMedian}s in the second. That is reacting, not deciding.`);
  }
  if (d.direction && d.direction.persistedIntoLoss) {
    out.push(`DIRECTION: all ${d.direction.trades} trades were ${d.direction.side} and the set lost ${money(d.direction.net)}. The read was never re-examined.`);
  }

  out.push('\nLOSS ATTRIBUTED BY CAUSE (mutually exclusive — these add up to the day):');
  d.causes.forEach((c) => {
    out.push(`  ${money(c.damage)} (${Math.abs(c.shareOfLoss)}%) — ${c.label} · trade(s) ${c.trades.join(', ')}`);
  });

  if (d.primary) {
    out.push(`\nCORE REASON: ${d.primary.label}. It owns ${money(d.primary.damage)}, ${Math.abs(d.primary.shareOfLoss)}% of everything lost today.`);
    if (d.primary.fix) out.push(`STRUCTURAL FIX (change the situation, not the intention): ${d.primary.fix}.`);
  } else {
    out.push('\nCORE REASON: none. Every loss today was taken inside the rules. That is a process win regardless of the money.');
  }
  return out.join('\n');
}

module.exports = {
  CAUSES,
  buildChain, findTurningPoint, attribute, concentration, holdCollapse,
  directionPersistence, diagnose, formatChain, formatDiagnosis, money,
};
