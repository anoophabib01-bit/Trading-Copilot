'use strict';
/* ── Self-authored guardrails ("armed detectors") ───────────────────────────
 * 2026-08-25. Anoop, after being told the Lessons tab fed nothing:
 * "idea 1 armed detector is good idea build it and make it part of the system"
 *
 * THE GAP THIS CLOSES
 * -------------------
 * The app could detect exactly four behaviours — F1 trade-count escalation,
 * F2 revenge cluster, F3 inverted R:R, F4 break-even churn — and every one of
 * them required a developer to write code. Meanwhile `Prop Trading/CLAUDE.md`
 * carries eight documented failure modes and an eleven-row Session Warning
 * Triggers table: things he ALREADY KNOWS kill his accounts, sitting in prose
 * that nothing executes. Holding losers 3+ hours, multi-instrument on a bad
 * day, trading after two red days, giving back a green day — all written
 * down, none watched.
 *
 * So the app's vigilance was frozen at whatever was last committed, while his
 * self-knowledge kept growing. And it grew in the Lessons tab, which was
 * write-only localStorage that no agent and no check ever read.
 *
 * This module is the missing half: a lesson can now carry a machine-checkable
 * condition, and promoting it ARMS that condition for the next session.
 *
 * HE PICKS A TEMPLATE — HE DOES NOT WRITE LOGIC
 * ---------------------------------------------
 * Every template below is a shape F1-F4 already are, with the numbers pulled
 * out as parameters. That is a deliberate ceiling. A free-form expression
 * language would be more powerful and would also let a typo arm something
 * that fires every poll or never fires at all, on a live-money account, with
 * no review. Templates are validated, bounded, and each one can state in
 * plain numbers why it fired.
 *
 * TWO FAILURE MODES, BOTH GUARDED
 * -------------------------------
 *   Too loud — a detector that fires constantly trains him to dismiss the
 *     whole channel, which would cost him F1-F4 as well. Guarded by
 *     MAX_ARMED, by once-per-day firing (server side), and by parameter
 *     bounds that refuse a threshold so low it must always match.
 *   Too quiet — a detector that never fires is WORSE than none, because he
 *     would believe he was covered. Guarded by tracking fireCount/lastFiredAt
 *     per lesson so the tab can say "armed 3 weeks ago, never fired" out
 *     loud instead of implying coverage it is not providing.
 *
 * Pure and side-effect-free. UMD: window.ArmedDetectors in the renderer,
 * CommonJS for server.js and the tests — one definition, so what he sees when
 * he arms it is exactly what runs during the session.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ArmedDetectors = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Four built-in patterns already fire on this channel. Six self-authored on
  // top is the point at which a session's alert traffic starts reading as
  // noise rather than signal — and the cost of noise here is that he stops
  // reading F1-F4 too. Arming is capped, not the log: he can write as many
  // lessons as he likes, he just cannot have more than this many watching.
  const MAX_ARMED = 6;

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const usable = (t) => t && !t.pnlUnknown && typeof t.pnl === 'number';
  // Trades in the order they were taken. Fold records carry `at` (the close);
  // stored rows carry `t` (the open). Either is a valid ordering key, and
  // sorting defensively means a caller passing an unsorted array cannot
  // silently produce a wrong streak or gap.
  const ordered = (trades) => (Array.isArray(trades) ? trades : [])
    .filter(Boolean)
    .slice()
    .sort((a, b) => (num(a.at) || num(a.t) || 0) - (num(b.at) || num(b.t) || 0));
  const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n * 100) / 100);

  /**
   * TEMPLATES. Each is a shape the four built-in detectors already have, with
   * the numbers exposed as bounded parameters.
   *
   * evaluate(ctx, p) -> { matched, message } — message MUST contain the real
   * numbers that made it fire. "You broke your rule" teaches nothing; "4
   * trades after your 2nd win" is the fact he can act on.
   */
  const TEMPLATES = [
    {
      id: 'trades-after-wins',
      label: 'Kept trading after winning',
      help: 'Fires when you take more trades after already having N winners. Your own note: "Stop at 2 good trades. Done."',
      params: [
        { key: 'wins', label: 'After this many wins', min: 1, max: 10, def: 2 },
        { key: 'extra', label: 'Trigger after this many more trades', min: 1, max: 10, def: 1 },
      ],
      evaluate(ctx, p) {
        const list = ordered(ctx.trades).filter(usable);
        let wins = 0, idx = -1;
        for (let i = 0; i < list.length; i++) {
          if (list[i].pnl > 0) { wins++; if (wins === p.wins) { idx = i; break; } }
        }
        if (idx < 0) return { matched: false };
        const after = list.length - (idx + 1);
        if (after < p.extra) return { matched: false };
        return {
          matched: true,
          message: `You said: stop at ${p.wins} winner${p.wins === 1 ? '' : 's'}. You have taken ${after} more trade${after === 1 ? '' : 's'} since your ${p.wins}${p.wins === 1 ? 'st' : 'nd'} win — ${list.length} total today.`,
        };
      },
    },
    {
      id: 'size-while-red',
      label: 'Sized up while down on the day',
      help: 'Fires when you open a trade bigger than N contracts while your running P&L is already below a threshold.',
      params: [
        { key: 'size', label: 'Size above', min: 1, max: 30, def: 2 },
        { key: 'below', label: 'While day P&L is below ($)', min: -5000, max: 0, def: 0 },
      ],
      evaluate(ctx, p) {
        const list = ordered(ctx.trades).filter(usable);
        let run = 0;
        for (const t of list) {
          // The running total BEFORE this trade is what he was staring at when
          // he chose the size. Adding this trade's own P&L first would judge
          // the decision by its outcome instead of by what he knew.
          if (num(t.size) > p.size && run < p.below) {
            return {
              matched: true,
              message: `You said: do not size up while red. You opened ${t.size} contracts with the day at ${money(run)} — your own limit is ${p.size}.`,
            };
          }
          run += t.pnl;
        }
        return { matched: false };
      },
    },
    {
      id: 'fast-reentry',
      label: 'Re-entered too soon after a loss',
      help: 'Fires when you re-enter within N minutes of closing a loser, N times in a day.',
      params: [
        { key: 'minutes', label: 'Within this many minutes of a loss', min: 1, max: 240, def: 15 },
        { key: 'times', label: 'This many times', min: 1, max: 20, def: 2 },
      ],
      evaluate(ctx, p) {
        const list = ordered(ctx.trades).filter(usable);
        let lastLossExit = null, hits = 0, fastest = null;
        for (const t of list) {
          const open = num(t.t) != null ? num(t.t) : num(t.at);
          if (lastLossExit != null && open != null) {
            const gapMin = (open - lastLossExit) / 60000;
            if (gapMin >= 0 && gapMin < p.minutes) {
              hits++;
              if (fastest === null || gapMin < fastest) fastest = gapMin;
            }
          }
          if (t.pnl < 0) lastLossExit = num(t.at) != null ? num(t.at) : open;
        }
        if (hits < p.times) return { matched: false };
        return {
          matched: true,
          message: `You said: wait ${p.minutes} minutes after a loss. You have re-entered inside that window ${hits} time${hits === 1 ? '' : 's'} today${fastest !== null ? ` — the fastest was ${fastest < 1 ? Math.round(fastest * 60) + ' seconds' : Math.round(fastest) + ' minutes'}` : ''}.`,
        };
      },
    },
    {
      id: 'pnl-band-churn',
      label: 'Too many trades that went nowhere',
      help: 'Fires when N trades land inside a P&L band — trades that cost commission and returned nothing.',
      params: [
        { key: 'band', label: 'Inside +/- ($)', min: 5, max: 1000, def: 100 },
        { key: 'count', label: 'This many trades', min: 2, max: 30, def: 5 },
      ],
      evaluate(ctx, p) {
        const list = ordered(ctx.trades).filter(usable);
        const be = list.filter((t) => Math.abs(t.pnl) < p.band);
        if (be.length < p.count) return { matched: false };
        return {
          matched: true,
          message: `You said: a trade inside +/-${money(p.band)} is not a trade. ${be.length} of your ${list.length} today landed inside that band.`,
        };
      },
    },
    {
      id: 'giveback',
      label: 'Gave back a green day',
      help: 'Fires when the day was up by N dollars and you have given back a percentage of that peak. Your account 6 peaked at +$937 and gave back $2,637.',
      params: [
        { key: 'peak', label: 'After being up at least ($)', min: 25, max: 10000, def: 300 },
        { key: 'pct', label: 'Given back this % of the peak', min: 10, max: 100, def: 50 },
      ],
      evaluate(ctx, p) {
        const list = ordered(ctx.trades).filter(usable);
        let run = 0, peak = 0;
        for (const t of list) { run += t.pnl; if (run > peak) peak = run; }
        if (peak < p.peak) return { matched: false };
        const given = peak - run;
        if (given < peak * (p.pct / 100)) return { matched: false };
        return {
          matched: true,
          message: `You said: protect a green day. You were up ${money(peak)} and are now at ${money(run)} — ${money(given)} given back, ${Math.round((given / peak) * 100)}% of the peak.`,
        };
      },
    },
    {
      id: 'total-contracts',
      label: 'Traded too much total size',
      help: 'Fires on TOTAL contracts for the day, not per trade. Ten legal 2-lots is twenty contracts, every one inside the rules, day already lost.',
      params: [{ key: 'max', label: 'Total contracts above', min: 1, max: 200, def: 12 }],
      evaluate(ctx, p) {
        const list = ordered(ctx.trades);
        // size 0 means "not observed", never zero contracts — so a day with
        // unobserved sizes UNDER-counts here. Saying so is the honest move;
        // silently reporting a low total as if it were the truth is not.
        const unknown = list.filter((t) => !(num(t.size) > 0)).length;
        const total = list.reduce((a, t) => a + (num(t.size) || 0), 0);
        if (total <= p.max) return { matched: false };
        return {
          matched: true,
          message: `You said: cap total size at ${p.max} contracts a day. You are at ${total}${unknown ? ` (and ${unknown} trade${unknown === 1 ? '' : 's'} had no observed size, so the real number is higher)` : ''}.`,
        };
      },
    },
    {
      id: 'hold-too-long',
      label: 'Held a trade too long',
      help: 'Fires when a trade is held past N minutes. Your own note: if it is not working in 5 minutes, the thesis is wrong.',
      params: [{ key: 'minutes', label: 'Held longer than (minutes)', min: 1, max: 480, def: 60 }],
      evaluate(ctx, p) {
        const list = ordered(ctx.trades);
        // holdSec comes from the walk join; hold from a stored row. A trade
        // with neither is not evidence of a short hold — it is no evidence,
        // so it is skipped rather than counted as compliant.
        let worst = null;
        for (const t of list) {
          const sec = num(t.holdSec) != null ? num(t.holdSec) : num(t.hold);
          if (sec == null || sec <= 0) continue;
          if (sec / 60 > p.minutes && (worst === null || sec > worst)) worst = sec;
        }
        if (worst === null) return { matched: false };
        return {
          matched: true,
          message: `You said: nothing held past ${p.minutes} minutes. One trade today ran ${Math.round(worst / 60)} minutes.`,
        };
      },
    },
    {
      id: 'red-day-streak',
      label: 'Traded after consecutive red days',
      help: 'Fires when you trade today after N losing days in a row. Five of six blown accounts died in five sessions or fewer with no rest after bad days.',
      params: [{ key: 'days', label: 'Consecutive red days', min: 1, max: 10, def: 2 }],
      evaluate(ctx, p) {
        // priorDays is newest-first, EXCLUDING today. Without it this cannot
        // be judged at all — returning "no match" on missing history would
        // read as "you are clear", so it must abstain instead.
        const prior = Array.isArray(ctx.priorDays) ? ctx.priorDays : null;
        if (!prior || prior.length < p.days) return { matched: false };
        if (!ordered(ctx.trades).length) return { matched: false };
        const streak = prior.slice(0, p.days);
        if (!streak.every((d) => d && num(d.pnl) != null && d.pnl < 0)) return { matched: false };
        const total = streak.reduce((a, d) => a + d.pnl, 0);
        return {
          matched: true,
          message: `You said: rest after ${p.days} red day${p.days === 1 ? '' : 's'}. The last ${p.days} sessions lost ${money(Math.abs(total))} (${streak.map((d) => d.date).join(', ')}) and you are trading today.`,
        };
      },
    },
  ];

  const byId = {};
  TEMPLATES.forEach((t) => { byId[t.id] = t; });

  function getTemplate(id) { return byId[id] || null; }

  /**
   * Validate one lesson's detector config. Returns { ok, errors: [] }.
   *
   * Every parameter is bounded by the template's own min/max. Those bounds
   * are not cosmetic: they are what stops "re-entered within 9999 minutes"
   * (fires on every second trade, forever) or "total contracts above 0"
   * (fires on the first trade of every day) from being armed at all.
   */
  function validate(lesson) {
    const errors = [];
    if (!lesson || typeof lesson !== 'object') return { ok: false, errors: ['no lesson'] };
    if (!String(lesson.text || '').trim()) errors.push('The lesson needs its own text — the detector is the check, the sentence is what you will read when it fires.');
    const d = lesson.detector;
    if (!d || !d.template) return { ok: false, errors: errors.concat(['No detector chosen.']) };
    const tpl = getTemplate(d.template);
    if (!tpl) return { ok: false, errors: errors.concat([`Unknown detector "${d.template}".`]) };
    const p = d.params || {};
    tpl.params.forEach((spec) => {
      const v = num(p[spec.key]);
      if (v === null) { errors.push(`"${spec.label}" needs a number.`); return; }
      if (v < spec.min || v > spec.max) {
        errors.push(`"${spec.label}" must be between ${spec.min} and ${spec.max} (got ${v}).`);
      }
    });
    return { ok: errors.length === 0, errors };
  }

  /** Fill any missing param with the template default. */
  function withDefaults(templateId, params) {
    const tpl = getTemplate(templateId);
    if (!tpl) return {};
    const out = {};
    tpl.params.forEach((spec) => {
      const v = num((params || {})[spec.key]);
      out[spec.key] = v === null ? spec.def : v;
    });
    return out;
  }

  /**
   * The armed subset, in the order they were armed, capped at MAX_ARMED.
   * A lesson is armed when it is promoted AND carries a valid detector.
   * Promotion without a detector stays exactly what it always was — a note.
   */
  function armed(lessons) {
    return (Array.isArray(lessons) ? lessons : [])
      .filter((l) => l && l.promoted && l.detector && validate(l).ok)
      .slice(0, MAX_ARMED);
  }

  /**
   * Evaluate every armed detector against today.
   *
   * ctx: { trades, priorDays }
   *   trades    — today's trades (fold shape: {pnl, size, at, t, holdSec})
   *   priorDays — newest-first [{date, pnl}], EXCLUDING today
   *
   * Returns only the ones that matched. A template that throws is reported as
   * an error rather than taking the poll down with it — this runs inside the
   * live broker loop on a real money account.
   */
  function evaluateAll(lessons, ctx) {
    const out = [];
    const c = ctx || {};
    armed(lessons).forEach((l) => {
      const tpl = getTemplate(l.detector.template);
      let r;
      try {
        r = tpl.evaluate(c, withDefaults(l.detector.template, l.detector.params));
      } catch (e) {
        out.push({ id: l.id, template: l.detector.template, matched: false, error: e.message });
        return;
      }
      if (r && r.matched) {
        out.push({
          id: l.id,
          template: l.detector.template,
          label: tpl.label,
          matched: true,
          lesson: String(l.text || '').trim(),
          message: r.message,
        });
      }
    });
    return out;
  }

  /**
   * One-line summary per armed detector, for the Lessons tab and for agent
   * context. Deliberately states the never-fired case out loud: an armed
   * detector that has never matched is either a habit he fixed or a check
   * that does not work, and he cannot tell which if the app stays quiet
   * about it.
   */
  function describeArmed(lessons, nowMs) {
    return armed(lessons).map((l) => {
      const tpl = getTemplate(l.detector.template);
      const p = withDefaults(l.detector.template, l.detector.params);
      const nums = tpl.params.map((s) => `${s.label}: ${p[s.key]}`).join(', ');
      const fired = Number(l.fireCount) || 0;
      let last = 'never fired since it was armed';
      if (fired > 0 && num(l.lastFiredAt)) {
        const days = Math.floor(((num(nowMs) || 0) - l.lastFiredAt) / 86400000);
        last = `fired ${fired}x, last ${days <= 0 ? 'today' : days + ' day' + (days === 1 ? '' : 's') + ' ago'}`;
      }
      return { id: l.id, text: String(l.text || '').trim(), label: tpl.label, params: nums, fired, summary: `${tpl.label} (${nums}) — ${last}` };
    });
  }

  return {
    TEMPLATES, MAX_ARMED,
    getTemplate, validate, withDefaults, armed, evaluateAll, describeArmed,
  };
});
