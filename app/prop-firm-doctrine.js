'use strict';
/* ── prop-firm-doctrine.js — Deva's playbook + the math of prop firms ───────
 * 2026-09-17. Two sources Anoop asked the WHOLE app to absorb — the Loop, the
 * agents and the coaching context:
 *   1. "The Math of Winning in Prop Firms"
 *      https://www.youtube.com/watch?v=CCu3YpugadQ
 *   2. Jasara podcast ep. 2 — Deva's journey (25 lakh lost -> consistent
 *      payouts)  https://www.youtube.com/watch?v=vGSpbspmGoM
 * NoteGPT transcripts live under .dsh-filess/session-1311a6f0-.../ in the
 * repo root.
 *
 * WHY A MODULE: the same doctrine must reach THE LOOP, Jessi, the Scalper,
 * the main chat (claude-agent.js personas) and the Post-Session Analyst, and
 * this repo's convention is ONE copy of a text, not N copies that drift (the
 * same reason claude-agent.js holds the tool schemas). Every section here is
 * exported as a plain string so a prompt builder can splice it in, and the
 * math is exported as pure functions so it is unit-testable — same split as
 * pattern-memory.js / week-rollup.js.
 *
 * WHAT THIS IS NOT: new enforcement. This module states doctrine and computes
 * numbers for context; it never places, closes or sizes a trade. Enforcement
 * stays in size-freeze-guard.js / oversize-guard.js / autonomy-modes.js /
 * handleTradeConfirm, exactly where it was before this file existed.
 *
 * UMD (2026-09-19): the renderer now READS this text too — the Rules tab shows
 * the doctrine the agents are running on. Same one-copy rule as above: a
 * paraphrase typed into the UI would be a second source of truth for the thing
 * the personas are quoting.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PropFirmDoctrine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

// ── Money formatting ───────────────────────────────────────────────────────
// Thousands-separated dollars, the same shape the app's own context blocks use
// ("$1,000", "-$1,718"). Local so this module needs no renderer helper — the
// grounding checker reads dollars by shape, and "$1,000" is what the agents
// already see everywhere else.
function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0';
  return (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US');
}
function money2(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0.00';
  return (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Pure math ──────────────────────────────────────────────────────────────

/**
 * Probability of N consecutive losses at a given win rate:
 * P = (1 - winRate)^n. The Math of Winning's table: at 45% win rate,
 * P(4 losses in a row) = 9.2%; at 55% = 4.1%; at 65% = 1.5%.
 * Returns a fraction (0..1) or null on invalid input.
 */
function streakRisk(winRate, n) {
  // Number(null) is 0 and Number('') is 0, so a MISSING win rate would have
  // silently computed as "0% win rate" — a number nobody measured. Reject the
  // shape before converting it. (Caught by test/prop-firm-doctrine.test.js.)
  if (winRate == null || winRate === '') return null;
  if (typeof winRate !== 'number' && typeof winRate !== 'string') return null;
  const wr = Number(winRate);
  const len = Number(n);
  if (!Number.isFinite(wr) || wr < 0 || wr > 1) return null;
  if (!Number.isInteger(len) || len < 1) return null;
  return Math.pow(1 - wr, len);
}

/**
 * Break-even win rate for a payoff (avgWin/avgLoss): 1 / (1 + payoff).
 * 1:1 -> 50%, 2:1 -> 33.3%, 3:1 -> 25%. A win rate below this is a losing
 * system at that payoff, no matter how good it feels.
 */
function breakevenWinRate(payoff) {
  const p = Number(payoff);
  if (!Number.isFinite(p) || p <= 0) return null;
  return 1 / (1 + p);
}

/**
 * Measured win rate from trade rows ({pnl} shaped, like day_trades rows).
 * Scratches (pnl === 0) are neither win nor loss — same rule as
 * expectancy.js. Returns null below minN DECIDED trades: a 2-trade sample
 * cannot describe an edge, and stating one anyway is how a coach stops
 * being believed.
 */
function winRateFromRows(rows, minN) {
  if (!Array.isArray(rows)) return null;
  let wins = 0, losses = 0;
  rows.forEach(function (r) {
    const p = Number(r && r.pnl);
    if (!Number.isFinite(p)) return;
    if (p > 0) wins += 1;
    else if (p < 0) losses += 1;
  });
  const n = wins + losses;
  const min = Number.isInteger(minN) && minN > 0 ? minN : 10;

  if (n < min) return null;
  return { winRate: wins / n, n };
}

/**
 * THE SURVIVAL MATH — one computed block every agent reads from context.
 * winRate: fraction or null (null -> the streak line is omitted, not guessed).
 * perTradeStopUsd: the operative per-trade stop (autoProtection bracket first,
 * perTradeMaxLoss as backstop).
 * dailyLossLimit / drawdownLimit: firm numbers from rules.json firmLimits
 * (Apex 50K EOD: $1,000 DLL ends the day; $2,000 threshold ends the account).
 * Returns a plain-text block in the canonical "$N" money shape the grounding
 * checker recognises — every figure in it is computed, never memorised.
 */
function formatSurvivalMath(opts) {
  const o = opts || {};
  const winRate = (o.winRate != null && o.winRate !== '') ? Number(o.winRate) : null;
  const nTrades = o.nTrades != null ? Number(o.nTrades) : null;
  const stop = Number(o.perTradeStopUsd);
  const dll = o.dailyLossLimit != null ? Number(o.dailyLossLimit) : null;
  const dd = o.drawdownLimit != null ? Number(o.drawdownLimit) : null;
  const prefix = o.prefix || 'SURVIVAL MATH — ';
  const bits = [];

  if (winRate != null && Number.isFinite(winRate)) {
    const streak4 = streakRisk(winRate, 4);
    let wrTxt = 'lifetime win rate ' + (winRate * 100).toFixed(0) + '%';
    if (nTrades != null && Number.isFinite(nTrades) && nTrades > 0) wrTxt += ' across ' + nTrades + ' decided trades';
    if (streak4 != null) {
      wrTxt += '; the chance of 4 consecutive losses is ' + (streak4 * 100).toFixed(1) + '%';
      const best = breakevenWinRate(1);
      if (best != null && winRate < best) wrTxt += ' — below the 50% break-even line at 1:1, so R:R or the win rate itself must improve';
    }
    bits.push(wrTxt + '.');
  } else {
    bits.push('Win rate not yet measurable (needs more decided trades) — the streak odds below are what the risk must survive regardless.');
  }

  if (Number.isFinite(stop) && stop > 0) {
    const cost4 = stop * 4;
    let stopTxt = 'At a ' + money(stop) + ' per-trade stop, a 4-loss streak costs ' + money(cost4);
    if (dll != null && Number.isFinite(dll) && dll > 0) {
      stopTxt += ' (' + Math.round((cost4 / dll) * 100) + '% of the ' + money(dll) + ' daily loss limit)';
    }
    if (dd != null && Number.isFinite(dd) && dd > 0) {
      stopTxt += ' (' + Math.round((cost4 / dd) * 100) + '% of the ' + money(dd) + ' drawdown)';
    }
    stopTxt += '.';
    bits.push(stopTxt);

    if (dll != null && Number.isFinite(dll) && dll > 0) {
      const stopsToDll = Math.floor(dll / stop);
      if (stopsToDll >= 1) bits.push(stopsToDll + ' consecutive full stops = ' + money(dll) + ' — the whole daily loss limit, and the day is over.');
    }
    if (dd != null && Number.isFinite(dd) && dd > 0) {
      const stopsToDd = Math.floor(dd / stop);
      if (stopsToDd >= 1) bits.push(stopsToDd + ' consecutive full stops = ' + money(dd) + ' — the whole drawdown, and the account is over.');
    }
  }

  if (dd != null && Number.isFinite(dd) && dd > 0) {
    bits.push('The ' + money(dd) + ' drawdown IS the real account — the advertised size is product size, and the drawdown is how many mistakes he can survive. The eval is a race: touch the profit target before the drawdown.');
  } else {
    bits.push('The real account is the drawdown, not the advertised size — it is how many mistakes he can survive.');
  }
  if (winRate != null && Number.isFinite(winRate)) {
    bits.push('Order decides a challenge as much as count: the same wins and losses pass or fail depending on which come first — size the risk so the WORST order survives.');
  }

  return prefix + bits.join(' ');
}

/**
 * The real-return line (The Math of Winning, part 5): payouts minus EVERY
 * account cost. "Do not be happy with just one payout — calculate the cost
 * of all the accounts purchased." Money in canonical "$N" shape.
 */
function realReturnLine(o) {
  const fees = Number(o && o.fees != null ? o.fees : 0);
  const payouts = Number(o && o.payouts != null ? o.payouts : 0);
  const count = Number(o && o.feeCount != null ? o.feeCount : 0);
  const net = payouts - fees;
  let out = 'REAL RETURN — ' + count + ' account(s) bought for ' + money2(fees)
    + ', payouts ' + money2(payouts) + ', NET ' + money2(net) + '.';
  if (count > 0 && payouts < fees) {
    out += ' The process is still net-negative: payouts must cover every attempt, not just one.';
  } else if (count > 0 && payouts >= fees) {
    out += ' Payouts currently cover the cost of the attempts — protect that, it is the actual game.';
  }
  out += ' Payout screenshots never show whether the full process made money.';
  return out;
}

// ── Doctrine text ──────────────────────────────────────────────────────────
// Full reference sections (sourced, quoted). The per-surface compact blocks
// further down are what actually get spliced into prompts.

const DEVA_DOCTRINE = `DEVA'S DOCTRINE — a profitable prop-firm trader whose journey mirrors Anoop's (25 lakh lost, then consistent payouts; source: Jasara podcast ep. 2, youtube.com/watch?v=vGSpbspmGoM):
1. "Small is big, less is more" — his trading motto. Small consistent profits compound; low expectations keep you grounded. Pedalling full throttle from the start is what killed his first years.
2. Slow and steady: rushing always messes things up. The market opens again tomorrow, next week, next year — there is no need to push.
3. Session craft: a fixed ~40-50 minute window, 1-2 entries a day, never a third. If the window yields nothing, stop anyway. If the day's range is small, trade the account with the biggest buffer.
4. Physically leave: after the daily number is hit, close the position AND physically remove yourself from the screen so you cannot trade again. Missing extra profit after that is not a mistake.
5. Know your satisfaction number: a fixed daily P&L band that closes the day (his: ~$290-330, cut manually at the band). Most traders never identify how much they need to make — the hunger without a number is what keeps them in the chair.
6. Eval plan: break the profit target into daily chunks ($3,000 -> $750 x 4 days). Plan the pass in 3-4 days. Bigger size in eval, RR ~1:1.5, stops 15-35 points.
7. Funded plan: respect the consistency cap (he works at HALF his firm's 20% cap); risk only $200-300 on a funded account; plan payouts over 10-15 days, never one session.
8. Drawdown over days: aim for the max drawdown but never spend it all in one day — losses should spread over 5-6 days. "You control the losses; the gains aren't in anyone's control." Losing one day is not recovered overnight.
9. RR realism: 1:5 / 1:6 R:R needs trending days that come 2-3 times a month, and a $2,000 drawdown does not survive 7-8 consecutive 20-point losses. High R:R means LOW frequency and only the highest-probability setups. Tight stops get snapped — pick stops the market takes its time to hit (15-30 points). RR and win rate move inversely.
10. Two journals: one for profitable days, one for losing days. Loss data is non-negotiable — why he lost, his psychological state, entry/exit criteria, the mistake. Without it, escaping losing streaks takes months longer.
11. Break-even phase protocol: cut position size (defensive = smaller size, not no trades) and ask "how many days does the market give me to grow this account?"
12. Post-payout relapse is a named hazard: after his first payout he blew 3 accounts on "it's easy, I did it before" — overtrading, stopped waiting, entered 5-10 candles early or not at all. Review the trades after any payout.
13. Scaling: prove 6-7 months of consistency first. "If someone hasn't been consistent for six or seven months, they're just not consistent." Never size up because of 4 winning trades. Reinvest business money; keep the cost of attempts low.
14. Budget discipline: a fixed monthly account budget (~$400-700), 4-5 accounts max, bought one at a time; order trades by payout probability — the account with the biggest buffer first.
15. Profitable character: "To be a profitable trader you need to build a profitable character — the character who sits in front of the screen for 1.5-2 hours and simply does not make those mistakes. If you can't play your character properly in that window, profitability will never show up." Mindset before targets.
16. Mental capital: protect mental capital above everything — the mental-drawdown phase is where most traders quit. Losing is how the character gets built; it is not the end.`;

const MATH_DOCTRINE = `PROP-FIRM MATH — the arithmetic of passing a challenge (source: "The Math of Winning in Prop Firms", youtube.com/watch?v=CCu3YpugadQ):
1. THE REAL ACCOUNT: a $50,000 eval is really a $2,000 account — the drawdown is the only money you are allowed to lose. The advertised size is product size; the drawdown tells you how many mistakes you can survive.
2. TWO BOUNDARIES: the job is to touch +$3,000 before -$2,000. The challenge already has a reward-to-risk ratio (1.5:1 on futures 50K) and the strategy must fit inside it.
3. ORDER/VARIANCE: two traders with the same 6 winners and 4 losers — one passes, one fails, purely from the ORDER the trades arrived. Ask before sizing up: "if these same trades come in the worst order, does the account survive?"
4. EXPECTANCY: winRate x avgWin - lossRate x avgLoss. Win rate alone is meaningless. Break-even: 50% at 1:1, 33% at 2:1, 25% at 3:1. A low win rate works only when the average win is large enough.
5. PASSING IS NOT PROFITABLE: a strategy profitable over time can still be a poor match for a tight challenge. The personal-account question is "can this make money?" — the prop-firm question is "can it reach the target before the loss limit?" Never confuse a lucky pass with a profitable system.
6. STREAK MATH: P(n consecutive losses) = (1 - winRate)^n. At 45% win rate, 4 losses in a row = 9.2%; at 55% = 4.1%; at 65% = 1.5%. Risk per trade is what makes the streak survivable.
7. SIZE SWEET SPOT: too small never reaches the target in time; too big lets one streak breach the drawdown. Risking 4% fails even at a 90% win rate. Size cannot CREATE an edge — a break-even strategy passes at the same rate at any size.
8. RULE LAYERS: every added rule (max drawdown, daily loss, trailing drawdown, consistency) lowers the chance of passing. EOD trailing is the forgiving kind (recalculated at the close); intraday trailing is more aggressive. The DLL ends the day; the drawdown threshold ends the account.
9. REAL RETURN: payouts minus EVERY cost (challenge fees + activations). 100 challenges x $150 = $15,000 spent; 6 payouts x $2,000 = $12,000 received; the group still lost $3,000. "Do not be happy with just one payout." The full question: does this strategy at this size inside these rules produce enough payouts to cover every attempt and leave money after?`;

// ── Per-surface compact blocks (spliced into prompts) ───────────────────────

// THE LOOP's context block. Tight on purpose: the Loop already carries the
// recurrence record, the causal chain and the account state — this is the
// reasoning frame it applies to them.
const LOOP_DOCTRINE = `— DEVA (profitable prop trader whose journey mirrors Anoop's; he asked for this to be absorbed):
1. "Small is big, less is more." Small consistent profits compound; full throttle from the start is what killed Deva's first years.
2. Slow and steady — the market opens again tomorrow. Rushing always messes things up. 1-2 entries a day, never a third.
3. After the daily number is hit: close AND physically leave the desk, not just close the platform.
4. The drawdown must last 5-6 days, never one. "You control the losses; the gains aren't in anyone's control." A losing day is not recovered overnight.
5. RR and win rate move inversely: 1:5 R:R on every trade is a losing-streak machine — high R:R only on the highest-probability setups.
6. After a payout, "it's easy, I did it before" breeds overtrading and early entries — Deva blew 3 accounts to it. It is a named relapse trigger.
7. Scale only after 6-7 months of provable consistency. Keep the cost of attempts low.
8. Two journals: winning days and losing days. Loss data is non-negotiable: why he lost, psychological state, entry/exit criteria, the mistake.
— THE MATH (of winning in prop firms):
9. The advertised size is product size; the drawdown IS the real account. The eval is a race: touch +$3,000 before -$2,000. The ORDER of wins and losses decides it, not just the count.
10. Expectancy = winRate x avgWin - lossRate x avgLoss. Win rate alone is meaningless (break-even 50% at 1:1, 33% at 2:1, 25% at 3:1). Passing a challenge is not proof of profitability.
11. Size cannot create an edge: too small never reaches the target, too big lets one streak breach the drawdown.
12. Real return = payouts minus every account fee. One payout does not make the process profitable.`;

// Splice into LOOP_AGENT_PERSONA.
const LOOP_PERSONA_SECTION = `## SURVIVAL MATH AND DEVA'S DOCTRINE (Anoop asked you to absorb both, 2026-09-17)
The SURVIVAL MATH block is computed from his own records — quote it exactly, and use it as the frame for your STRUCTURAL FIX: a fix that does not survive a 4-loss streak, or that spends the whole drawdown in one day, is not a fix. The PROP-FIRM DOCTRINE block is a profitable prop trader's playbook plus the arithmetic of passing a challenge. When one of Deva's lines fits the pattern, say it in his words — "small is big, less is more" for overtrading, "the drawdown must last 5-6 days, never one" for a day that spent the account, "the market opens again tomorrow" for the urge to push for one more entry.`;

// Splice into SHARED_RULES (main chat, claude-agent.js).
const JESSI_MATH_SECTION = `## PROP-FIRM MATH — THE REAL ACCOUNT (absorbed 2026-09-17 from "The Math of Winning in Prop Firms")
- The advertised size is not the account: on a 50K eval the $2,000 drawdown IS the account — it is how many mistakes he can survive. The eval is a race between two boundaries: touch +$3,000 before -$2,000, and the ORDER of wins and losses decides it as much as the count. A strategy can be profitable and still fail a tight challenge.
- Expectancy = winRate x avgWin - lossRate x avgLoss. Win rate alone means nothing: break-even is 50% at 1:1, 33% at 2:1, 25% at 3:1. Passing a challenge is not proof of a profitable system — a losing system can pass by luck.
- P(4 consecutive losses) is 9.2% at a 45% win rate, 4.1% at 55%, 1.5% at 65%. Risk per trade decides whether the streak is survivable: too small never reaches the target, too big lets one streak breach the drawdown. Size cannot CREATE an edge.
- Real return = payouts minus EVERY cost (challenge fees + activations). Payout screenshots do not show whether the process made money; the test is whether payouts cover all attempts. "Do not be happy with just one payout."`;

// Splice into JESSI_PERSONA.
const DEVA_JESSI_SECTION = `## DEVA'S DOCTRINE (2026-09-17 — a profitable Indian prop trader whose journey mirrors his: 25 lakh lost, then consistent payouts; Anoop asked for this to be part of your coaching)
It is a second voice, not a new rulebook — use it when it lands, and quote it in Deva's words:
- "Small is big, less is more" — small consistent profits compound; low expectations keep you grounded. Full throttle from the start is what killed Deva's first years and what kills eval accounts.
- Slow and steady: the market opens again tomorrow, next week, next year. Rushing always messes things up.
- A fixed session window (Deva: ~40-50 minutes, 1-2 entries, never a third) — after the daily number is hit, he closes AND physically leaves the desk.
- The daily number: identify the hunger — pick a $ band that satisfies (his: ~$290-330) and close at it without mourning the missed extra.
- The drawdown must last 5-6 days, never one. "You control the losses; the gains aren't in anyone's control."
- Two journals: one for winning days, one for losing days. Loss data is non-negotiable — why he lost, his psychological state, entry/exit criteria, the mistake. Without it, losing streaks take months longer to escape.
- Post-payout relapse is a named hazard: after a payout, "it's easy, I did it before" breeds overtrading and early entries — Deva blew 3 accounts to it. Watch for it after any payout or big green day.
- "Build a profitable character": the version of him who sits in front of the screen for 1.5-2 hours and simply does not make those mistakes. Mindset before any account target.`;

// Splice into SCALPER_PERSONA (items 8-10 of its craft list).
const DEVA_SCALPER_SECTION = `8. **Deva's scalping craft (2026-09-17 — a profitable Indian prop trader Anoop asked you to absorb).** Fixed ~40-50 minute session, 1-2 entries and never a third — the system doesn't allow more and he does not push. RR ~1:1.5 with 15-35 point stops: tight stops get snapped, and 1:5 R:R needs trending days that come 2-3 times a month — high R:R only on the highest-probability setups, never on every trade. When the daily number is hit: close AND physically leave the desk. "Small is big, less is more."
9. **The drawdown must last days, not one session.** A $2,000 drawdown at $200 risk per trade is 10 stops — spend it over 5-6 days, never one. Losses are controllable; gains are not. After a losing day, the next day starts SMALLER, not bigger.
10. **Streak math decides the stop distance.** At a ~50% win rate the chance of 4 consecutive losses is ~6%; the per-trade stop must be sized so that streak is survivable. The app computes his exact numbers in the DRAWDOWN AMMUNITION line of the account data — quote it, don't estimate.`;

// Splice into POST_SESSION_ANALYST_PERSONA.
const POST_SESSION_SECTION = `When a day's loss was decided by size or a losing streak, state it in survival-math terms from the DRAWDOWN AMMUNITION line: how many per-trade stops the day spent and what share of the drawdown that was. The drawdown is the real account, not the $50,000 — and a day that spends it all at once is the account-death mode, whatever the rules say was broken.`;

return {
  streakRisk,
  breakevenWinRate,
  winRateFromRows,
  formatSurvivalMath,
  realReturnLine,
  DEVA_DOCTRINE,
  MATH_DOCTRINE,
  LOOP_DOCTRINE,
  LOOP_PERSONA_SECTION,
  JESSI_MATH_SECTION,
  DEVA_JESSI_SECTION,
  DEVA_SCALPER_SECTION,
  POST_SESSION_SECTION,
};
});
