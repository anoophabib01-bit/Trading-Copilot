'use strict';
/* ── day-plan.js — the numbers that decide whether today is finished ─────────
 * 2026-09-19. Built from the doctrine Anoop asked the app to absorb (see
 * app/prop-firm-doctrine.js — Deva's podcast + "The Math of Winning in Prop
 * Firms"). Three surfaces, ONE module, because all three answer the same
 * question — "what is today's plan, and where am I against it?" — and the HUD,
 * the guardrail banner and the coaching agents must never answer it
 * differently:
 *
 *   satisfactionStatus()  Deva's most repeated advice: pick a $ band that
 *                         satisfies you, close at it, and physically leave the
 *                         desk. The app has always been able to say he was DOWN
 *                         too much. It had no way to say he was UP enough —
 *                         which is the half that actually ends his days.
 *   evalPlan()            Deva's eval method: break the target into daily
 *                         chunks ($3,000 -> $750 x 4 days) and win on pace,
 *                         not on hero days. The chunk is computed from the
 *                         LIVE distance to target, so it can never go stale.
 *   streakGate()          The math half: after N consecutive losses, how many
 *                         full stops are left before the daily loss limit and
 *                         before the drawdown? "The drawdown must last 5-6
 *                         days, never one."
 *
 * PURE. No clock, no disk, no app state — every function is handed what it
 * needs, the same discipline as pattern-memory.js and armed-detectors.js. UMD,
 * so the renderer reads the SAME definitions the server does
 * (window.DayPlan / require): that is the only way the HUD tag and the
 * coaching sentence are guaranteed to agree.
 *
 * NOT ENFORCEMENT. Nothing here blocks a trade, sizes one, or closes a
 * position. It states the plan and the remaining room. Enforcement stays in
 * size-freeze-guard.js / oversize-guard.js / handleTradeConfirm.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DayPlan = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const num = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null; }
    return null;
  };
  const money = (n) => {
    const v = num(n) || 0;
    return (v < 0 ? '-$' : '$') + Math.abs(Math.round(v * 100) / 100).toLocaleString('en-US');
  };
  const round2 = (n) => Math.round((num(n) || 0) * 100) / 100;

  // Trades in the order they were taken. Fold records carry `at` (the close),
  // stored rows carry `t` (the open) — sorting defensively means a caller
  // passing an unsorted array cannot silently produce a wrong streak.
  function ordered(trades) {
    return (Array.isArray(trades) ? trades : [])
      .filter(Boolean)
      .filter((t) => num(t.pnl) != null)
      .slice()
      .sort((a, b) => (num(a.at) || num(a.t) || 0) - (num(b.at) || num(b.t) || 0));
  }

  /**
   * Consecutive losses at the END of the day so far.
   *
   * A SCRATCH ENDS A STREAK. pnl === 0 is not a loss, and treating it as one
   * would let a churned break-even trade inflate a streak that did not happen;
   * treating it as a win would break a run of real losses. It simply ends the
   * run — the same rule expectancy.js uses to keep scratches out of both the
   * win and the loss buckets.
   */
  function consecutiveLosses(trades) {
    const list = ordered(trades);
    let streak = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].pnl < 0) streak += 1;
      else break;
    }
    return streak;
  }

  // ── 1. The satisfaction number ─────────────────────────────────────────────
  /**
   * cfg comes from rules.json's `satisfaction` block: { enabled, amountUsd }.
   * Returns { enabled, reached, target, dayPnl, pct, remaining, text }.
   *
   * Deliberately ADVISORY. Reaching the number is not a trade block and does
   * not touch the day stop — it is the sentence he has never had from this
   * app: today is already a good day, and the next trade can only take that
   * away from him.
   */
  function satisfactionStatus(opts) {
    const o = opts || {};
    const cfg = o.cfg || {};
    const target = num(o.target != null ? o.target : cfg.amountUsd);
    const dayPnl = num(o.dayPnl);
    if (cfg.enabled === false || target == null || target <= 0) {
      return { enabled: false, reached: false, target: null, pct: null, text: '' };
    }
    if (dayPnl == null) return { enabled: true, reached: false, target, pct: null, text: '' };
    const pct = Math.max(0, Math.min(100, Math.round((dayPnl / target) * 100)));
    const reached = dayPnl >= target;
    const remaining = reached ? 0 : round2(target - dayPnl);
    // A RED DAY GETS NO SATISFACTION LINE. "You are -$280 against a $300
    // target, $580 to go" is arithmetically true and completely wrong in tone:
    // it frames a losing day as a shortfall against a profit goal, which is the
    // pressure the number exists to remove. When the day is red the day-stop
    // tiers and the streak gate own that state and this stays silent.
    if (dayPnl < 0) return { enabled: true, reached: false, target, dayPnl, pct: 0, remaining, text: '' };
    const text = reached
      ? 'SATISFACTION NUMBER HIT — ' + money(dayPnl) + ' against a ' + money(target)
        + ' target for the day. Close the platform AND physically leave the desk; the extra you might'
        + ' have made is not worth the day you already have.'
      : 'Today is ' + money(dayPnl) + ' against a ' + money(target) + ' satisfaction number ('
        + pct + '%' + (reached ? '' : ', ' + money(remaining) + ' to go') + ').';
    return { enabled: true, reached, target, dayPnl, pct, remaining, text };
  }

  // ── 2. The eval pace plan ─────────────────────────────────────────────────
  /**
   * cfg: { enabled, days }. balance/targetBalance come from the live account
   * and rules.json (start + profitTarget), never from a literal — a hardcoded
   * "$750/day" would be wrong the moment the eval is partway through, which is
   * the whole reason this is computed.
   *
   * `days` is the plan, not a countdown: if he is on day 1 of a 4-day plan the
   * chunk is a quarter of what remains. `dayNumber` is optional context so the
   * line can say where he is in the plan without inventing a calendar.
   */
  function evalPlan(opts) {
    const o = opts || {};
    const cfg = o.cfg || {};
    const balance = num(o.balance);
    const targetBalance = num(o.targetBalance);
    const daysRaw = num(o.days != null ? o.days : cfg.days);
    const days = daysRaw != null && daysRaw >= 1 ? Math.floor(daysRaw) : null;
    if (cfg.enabled === false || balance == null || targetBalance == null || days == null) {
      return { enabled: false, remaining: null, chunk: null, text: '' };
    }
    const remaining = Math.max(0, round2(targetBalance - balance));
    // The chunk is rounded to whole dollars — a "daily target" of $447.50 is
    // false precision on a plan number, and it reads like a computed quota
    // rather than a pace. `remaining` stays exact to the cent.
    const chunk = Math.round(remaining / days);
    const todayPnl = num(o.todayPnl);
    const dayNumber = num(o.dayNumber);
    let text;
    if (remaining <= 0) {
      text = 'EVAL TARGET REACHED — balance ' + money(balance) + ' against a target of '
        + money(targetBalance) + '. Nothing left to make; the risk from here is all downside.';
    } else {
      text = 'EVAL PACE — ' + money(remaining) + ' left to the target; over a ' + days + '-day plan that is '
        + money(chunk) + ' a day' + (dayNumber != null && dayNumber > 0 ? ' (plan day ' + dayNumber + ' of ' + days + ')' : '')
        + '. Deva\'s method: identical rule-clean chunks, not hero days — one big day is not the plan.';
      // suppressShortfall: set by todayPlanBlock when the satisfaction number is
      // already hit. Saying "you are $75 short of today's chunk" in the same
      // breath as "close the platform and leave" is two opposite instructions.
      if (todayPnl != null) {
        if (todayPnl >= chunk) text += ' Today: ' + money(todayPnl) + ' — today\'s chunk is already made.';
        else if (!o.suppressShortfall) text += ' Today: ' + money(todayPnl) + ' — ' + money(round2(chunk - todayPnl)) + ' short of today\'s chunk.';
      }
    }
    return { enabled: true, remaining, chunk, days, dayNumber: dayNumber, todayPnl: todayPnl, reached: remaining <= 0, text };
  }

  // ── 3. The streak gate ────────────────────────────────────────────────────
  /**
   * cfg: { enabled, afterLosses }. Everything else is measured: consecutive
   * losses from today's trades, per-trade stop from the live bracket, and the
   * firm's daily loss limit / drawdown from rules.json firmLimits.
   *
   * The point is to state the remaining room in STOPS. "You have $600 of
   * room" is a number he has to translate under pressure; "three full stops
   * and the day is over" is the same fact already translated.
   */
  function streakGate(opts) {
    const o = opts || {};
    const cfg = o.cfg || {};
    if (cfg.enabled === false) return { enabled: false, matched: false, losses: 0, text: '' };
    const afterRaw = num(cfg.afterLosses);
    const after = afterRaw != null && afterRaw >= 1 ? Math.floor(afterRaw) : 4;
    const losses = o.losses != null ? (num(o.losses) || 0) : consecutiveLosses(o.trades);
    const stop = num(o.perTradeStopUsd);
    const dll = num(o.dailyLossLimit);
    const dd = num(o.drawdownLimit);
    const dayPnl = num(o.dayPnl);

    const out = {
      enabled: true, matched: losses >= after, losses, afterLosses: after,
      stopsToDll: null, stopsToDrawdown: null, roomToDll: null, text: '',
    };
    if (!out.matched) return out;

    let room = '';
    if (dayPnl != null && dll != null && dll > 0) {
      const left = Math.min(dll, Math.max(0, round2(dll + dayPnl)));
      out.roomToDll = left;
      out.stopsToDll = stop != null && stop > 0 ? Math.floor(left / stop) : null;
      room += ' ' + money(left) + ' of daily-loss room left'
        + (out.stopsToDll != null ? ' — ' + out.stopsToDll + ' full ' + money(stop) + ' stop'
          + (out.stopsToDll === 1 ? '' : 's') : '')
        + ' before the ' + money(dll) + ' limit ends the day.';
    } else if (stop != null && stop > 0 && dd != null && dd > 0) {
      out.stopsToDrawdown = Math.floor(dd / stop);
      room += ' A ' + money(dd) + ' drawdown at ' + money(stop) + ' a stop is '
        + out.stopsToDrawdown + ' stops in total, across every day.';
    } else {
      room += ' Stop distance or loss limit is not readable, so the remaining room cannot be stated — treat it as unknown, not as room.';
    }

    out.text = 'STREAK GATE — ' + losses + ' consecutive losses (threshold ' + after + ').' + room
      + ' The drawdown must last 5-6 days, never one; you control the losses, the gains are not in anyone\'s control.'
      + ' Size and stop are decided before the next entry, or there is no next entry.';
    return out;
  }

  /**
   * One text block for the agents' account context: the plan, the pace and the
   * streak — each only when it actually has something to say. Returns '' when
   * none of the three can speak, so a caller can skip the line entirely rather
   * than print an empty heading.
   */
  function todayPlanBlock(opts) {
    const o = opts || {};
    const lines = [];
    const sat = satisfactionStatus({ cfg: o.satisfaction, dayPnl: o.dayPnl });
    if (sat.enabled && sat.text) lines.push(sat.text);
    const plan = evalPlan({
      cfg: o.evalPlanCfg, balance: o.balance, targetBalance: o.targetBalance,
      days: o.days, todayPnl: o.dayPnl, dayNumber: o.dayNumber,
      // The day is already won — do not also tell him he is short of a chunk.
      suppressShortfall: sat.reached,
    });
    if (plan.enabled && plan.text) lines.push(plan.text);
    const gate = streakGate({
      cfg: o.streakCfg, trades: o.trades, losses: o.losses,
      perTradeStopUsd: o.perTradeStopUsd, dailyLossLimit: o.dailyLossLimit,
      drawdownLimit: o.drawdownLimit, dayPnl: o.dayPnl,
    });
    if (gate.enabled && gate.text) lines.push(gate.text);
    if (!lines.length) return '';
    return 'TODAY\'S PLAN — ' + lines.join(' ');
  }

  /**
   * The ONE place that answers "what balance is this account trying to
   * reach?" Every surface — left card, Pass Math, Coach's Notes, the Day
   * Plan, the Ladder and the server's agent context — must call this rather
   * than each resolving its own fallback. The 2026-09-21 bug that forced this
   * was exactly four different fallbacks for the same number: the left card
   * and Pass Math used `live || (start + target)`, Coach's Notes used
   * `live || 159000` (a hardcoded 150K leftover), and the Day Plan used
   * `live` only (so it rendered "—" beside a card that showed $53,000).
   *
   *   mode   'eval' | 'funded'
   *   liveTarget       acc.evalTarget (eval) / acc.payoutTarget (funded)
   *   startBalance     profile start balance
   *   profitTarget     eval profile target increment (e.g. 3000 on 50K)
   *   payoutProfileTarget  funded profile payout target (e.g. 52000)
   *
   * Precedence (eval):  liveTarget if positive, else start + profitTarget,
   * else null. Precedence (funded): liveTarget if positive, else the
   * profile payout target if positive, else start + 3000 (the existing
   * funded fallback), else null. Returns null only when nothing is known.
   */
  function resolveTarget(opts) {
    const o = opts || {};
    const mode = o.mode === 'eval' ? 'eval' : 'funded';
    const live = num(o.liveTarget);
    const start = num(o.startBalance);
    const profit = num(o.profitTarget);
    if (mode === 'eval') {
      if (live != null && live > 0) return live;
      if (start != null && start > 0 && profit != null) return round2(start + profit);
      return null;
    }
    if (live != null && live > 0) return live;
    const pp = num(o.payoutProfileTarget);
    if (pp != null && pp > 0) return pp;
    if (start != null && start > 0) return round2(start + 3000);
    return null;
  }

  return {
    consecutiveLosses,
    satisfactionStatus,
    evalPlan,
    streakGate,
    resolveTarget,
    todayPlanBlock,
    // exported for tests and for callers that need the same shape
    money,
  };
});
