// ── Post-Session orchestrator-workers (2026-08-16, Pattern 04) ──────────────
// Anthropic's "Building Effective Agents": orchestrator-workers fits when
// "you can't predict the subtasks needed" — the key difference from plain
// parallelization is that subtasks aren't fixed in advance, they're decided
// per input.
//
// BEFORE: handlePostSessionReview() ran ONE monolithic prompt, every time,
// that tried to cover all 7 of SHARED_RULES' documented failure modes plus
// bias-adherence plus checklist-skip in a single pass — fixed cost whether
// the session was clean or a genuine blow-up, and one generalist call is
// worse at catching a specific pattern than a call whose entire focus is
// that one pattern (the same reasoning the article gives for the sectioning
// variant of parallelization, applied here to a variable-sized set of
// sections).
//
// AFTER: this module is the ORCHESTRATOR half — but deliberately a
// DETERMINISTIC one, not an LLM deciding subtasks. The article's own
// examples (coding agents, multi-source search) need an LLM to plan because
// the mapping from input to subtasks isn't knowable in advance. Here it is:
// gr_history (copilot_gr_history, one row per trading day) already carries
// the exact numeric fields this maps from — over, revenge, giveback,
// holdExceeded, under5, sizedUpIntoLoss, tradedPast3Losses — because
// grUpdate() in the renderer computes them every day regardless. Turning a
// well-defined threshold check into an LLM call would be the article's own
// warning in reverse: "only increase complexity when it demonstrably
// improves outcomes." Thresholds are cheaper, instant, and cannot drift
// between two runs on the same data — see stage-rules.js /
// journey-tracker.js for the same judgment call made elsewhere in this app.
//
// Workers are the article's actual LLM-decomposition value: each triggered
// topic gets ONE short, single-purpose call (via the existing
// runDebateAgent() helper in server.js — no new call machinery needed) so a
// clean day costs near nothing and a bad day gets real per-pattern depth
// instead of one generalist trying to remember eight things at once.

const TOPICS = {
  escalation: {
    title: 'Trade-count escalation',
    persona: `You are a focused pattern auditor for Anoop Habib's trading co-pilot. Your ONLY job: assess today's trade count against his documented pattern — profitable days run 6-12 trades, blow-up days run into the 60s at a ~20% win rate. State the count, say plainly whether today matches the escalation pattern, and name ONE concrete number-based reason (not a feeling) for your read. Under 60 words. No verdict, no GO/NO-GO — a synthesis step owns that.`
  },
  revenge: {
    title: 'Revenge clusters',
    persona: `You are a focused pattern auditor. Your ONLY job: assess today's revenge-flagged trades (rapid re-entry at the same zone after a loss, often with increasing size). State the count and, if size increased after a loss, say so explicitly with the sizes involved. Under 60 words. No verdict — a synthesis step owns that.`
  },
  invertedRR: {
    title: 'Inverted risk:reward',
    persona: `You are a focused pattern auditor. Your ONLY job: compare today's average win to average loss. A healthy day has avg win > avg loss; an inverted day (cutting winners, holding losers) has it backwards. State both numbers and say plainly which way today points. Under 60 words. No verdict.`
  },
  holdingLosers: {
    title: 'Holding losers past the time stop',
    persona: `You are a focused pattern auditor. Your ONLY job: how many of today's trades held past the max-hold rule (a losing position that should have been time-stopped)? State the count. Under 50 words. No verdict.`
  },
  giveback: {
    title: 'Giving back gains',
    persona: `You are a focused pattern auditor. Your ONLY job: today's peak intraday profit vs. how much of it was given back by end of day. State both numbers plainly — this is the exact shape of Pattern 6 in his documented failure modes (up big, then crashed). Under 60 words. No verdict.`
  },
  fastEntries: {
    title: 'Entering too fast',
    persona: `You are a focused pattern auditor. Your ONLY job: what fraction of today's trades were held under 5 minutes? A majority under 5 minutes across many trades reads as reflexive re-entry rather than planned scalping. State the fraction plainly. Under 50 words. No verdict.`
  },
  biasAdherence: {
    title: 'Bias adherence',
    persona: `You are a focused pattern auditor. Your ONLY job: summarize whether today's actual trades followed his declared pre-session direction, using the adherence data given to you verbatim — do not recompute or re-estimate any percentage or dollar figure. Under 70 words. No verdict.`
  },
  checklistSkip: {
    title: 'Checklist compliance',
    persona: `You are a focused pattern auditor. Your ONLY job: state plainly whether today's pre-trade checklist was completed, skipped, or done late, using the record given to you. Under 40 words. No verdict.`
  }
};

// Pure. Never throws on missing/partial input — a post-session review must
// never fail to render because one signal source (bias matrix, checklist
// history) was unavailable; it just means fewer workers fire, never zero
// output. Mirrors checklist-logic.js's ckGateOpen fail-open philosophy,
// applied to "which workers run" instead of "is the gate locked."
function detectFlags({ gr, quadrant, ckToday, rules } = {}) {
  const flags = [];
  rules = rules || {};
  try {
    if (gr && typeof gr === 'object') {
      const tradesPerDay = rules.tradesPerDay || 10;
      const tradesPerSession = rules.tradesPerSession || 5;
      if (typeof gr.n === 'number' && (gr.n >= tradesPerDay || gr.n > tradesPerSession * 2)) {
        flags.push('escalation');
      }
      if (typeof gr.revenge === 'number' && gr.revenge > 0) flags.push('revenge');
      if (typeof gr.avgLoss === 'number' && typeof gr.avgWin === 'number' && gr.losses > 0
        && Math.abs(gr.avgLoss) > 0 && Math.abs(gr.avgLoss) > gr.avgWin * 2) {
        flags.push('invertedRR');
      }
      if (typeof gr.holdExceeded === 'number' && gr.holdExceeded > 0) flags.push('holdingLosers');
      if (typeof gr.giveback === 'number' && gr.giveback > 0 && typeof gr.peak === 'number' && gr.peak > 0) {
        flags.push('giveback');
      }
      if (typeof gr.under5 === 'number' && typeof gr.n === 'number' && gr.n > 0 && (gr.under5 / gr.n) >= 0.6) {
        flags.push('fastEntries');
      }
    }
  } catch (e) { /* one bad field must not cost every other check */ }

  try {
    const badQuadrants = ['GOT_AWAY_WITH_IT', 'DOUBLE_FAILURE', 'HONEST_MISS'];
    if (quadrant && badQuadrants.indexOf(quadrant) !== -1) flags.push('biasAdherence');
  } catch (e) {}

  try {
    if (ckToday && ckToday.tier === 'SKIPPED') flags.push('checklistSkip');
  } catch (e) {}

  return flags;
}

function selectWorkers(flags) {
  return (flags || [])
    .filter(f => TOPICS[f])
    .map(f => ({ topic: f, title: TOPICS[f].title, persona: TOPICS[f].persona }));
}

// The parts of "SESSION SUMMARY" that are pure arithmetic on gr — no LLM
// needed, and removes one entire section's chance of the model mis-adding a
// column of numbers it was already handed correctly. Returns null (not a
// throw) if gr is absent, so the synthesis step can say so plainly.
function deterministicSummary(gr) {
  if (!gr || typeof gr !== 'object') return null;
  const money = n => (n == null ? '?' : ((n < 0 ? '-$' : '$') + Math.abs(Math.round(n * 100) / 100).toLocaleString()));
  const winRate = (gr.wins != null && gr.losses != null && (gr.wins + gr.losses) > 0)
    ? Math.round((gr.wins / (gr.wins + gr.losses)) * 100) + '%'
    : 'n/a';
  return `Date: ${gr.date || '?'} · Trades: ${gr.n != null ? gr.n : '?'} · Gross: ${money(gr.gross)} · Net: ${money(gr.pnl)} · `
    + `Win rate: ${winRate} (${gr.wins != null ? gr.wins : '?'}W/${gr.losses != null ? gr.losses : '?'}L) · `
    + `Max size: ${gr.maxSize != null ? gr.maxSize : '?'} · Contracts: ${gr.contracts != null ? gr.contracts : '?'} · `
    + `Discipline score: ${gr.disc != null ? gr.disc + '%' : '?'}`;
}

module.exports = { TOPICS, detectFlags, selectWorkers, deterministicSummary };
