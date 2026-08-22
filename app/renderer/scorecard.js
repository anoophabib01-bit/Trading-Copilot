/* ── Per-playbook scorecard (LIVE_FEED_LOOP_PLAN.md task 5.2) ─────────────
 * Pure computation: signal-ledger rows (fired/rejected/decisions) × day rows
 * (signalBacked trades with pnl). "Avg R" is realized profit factor
 * (total won / |total lost|) — the plan's column name, computed honestly
 * from realized dollars, never from planned R multiples (the feed has no
 * planned stop/target). Display stays GATED on H6 (per-trade P&L attribution
 * confirmed) — a confident wrong scorecard drives worse decisions than none.
 * UMD: browser (window.Scorecard) + Node (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Scorecard = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PLAYBOOKS = ['A', 'B', 'C', 'PO3'];
  const ARMING = new Set(['engulf-fire', 'fvg-fire', 'playbook-b-confirm']);

  function freshBucket() {
    return { fired: 0, valid: 0, rejected: 0, taken: 0, passed: 0, ignored: 0, wins: 0, losses: 0, grossWon: 0, grossLost: 0, net: 0, winPct: null, avgR: null };
  }

  function computeScorecard(rows, signals) {
    const sRows = Array.isArray(rows) ? rows : [];
    const sigs = Array.isArray(signals) ? signals : [];
    const byPlaybook = {};
    PLAYBOOKS.forEach(p => { byPlaybook[p] = freshBucket(); });
    for (const s of sigs) {
      if (!s || !s.playbook || !byPlaybook[s.playbook]) continue;
      const b = byPlaybook[s.playbook];
      if (s.event === 'playbook-c-reject') { b.rejected++; continue; }
      if (s.event === 'signal-decision') {
        if (s.decision === 'took') b.taken++;
        else if (s.decision === 'passed') b.passed++;
        else if (s.decision === 'ignored') b.ignored++;
        continue;
      }
      if (s.event === 'signal-expired') { b.ignored++; continue; }
      if (ARMING.has(s.event)) { b.fired++; if (s.valid !== false) b.valid++; continue; }
      if (s.event === 'po3-phase-change') { b.fired++; if (s.valid !== false) b.valid++; continue; }
      if (s.event === 'signal-join') { continue; } // joins are stamped on rows, not counted here
    }
    const backed = { wins: 0, losses: 0, net: 0, count: 0 };
    const freestyle = { wins: 0, losses: 0, net: 0, count: 0 };
    for (const r of sRows) {
      const pnl = Number(r.pnl) || 0;
      const win = pnl > 0;
      const loss = pnl < 0;
      const bucket = r.signalBacked === true ? backed : freestyle;
      bucket.count++;
      if (win) bucket.wins++;
      else if (loss) bucket.losses++;
      bucket.net += pnl;
      if (r.signalBacked === true && r.playbook && byPlaybook[r.playbook]) {
        const b = byPlaybook[r.playbook];
        if (win) { b.wins++; b.grossWon += pnl; }
        else if (loss) { b.losses++; b.grossLost += pnl; }
        b.net += pnl;
      }
    }
    PLAYBOOKS.forEach(p => {
      const b = byPlaybook[p];
      b.net = Math.round(b.net * 100) / 100;
      b.winPct = (b.wins + b.losses) ? Math.round(b.wins / (b.wins + b.losses) * 100) : null;
      b.avgR = (b.wins + b.losses && b.grossLost < 0) ? Math.round((b.grossWon / Math.abs(b.grossLost)) * 100) / 100 : null;
    });
    backed.net = Math.round(backed.net * 100) / 100;
    freestyle.net = Math.round(freestyle.net * 100) / 100;
    return { byPlaybook, backed, freestyle };
  }

  return { computeScorecard, PLAYBOOKS, freshBucket };
});
