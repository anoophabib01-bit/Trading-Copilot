// ── THE RISK MANAGEMENT PROTOCOL (2026-09-04) ────────────────────────────────
//
// WHY THIS IS CODE AND NOT A DOCUMENT
// This repo has already proved that a written rule is not a rule. Prop
// Trading/CLAUDE.md said "Max 2 contracts per entry. Hard cap. No exceptions"
// while rules.json said 6 and nothing enforced either number — documented, and
// three times looser in practice, for months. On 2026-09-03 a 20-lot went out
// against a stated cap of 2.
//
// So the protocol is a REGISTRY the machine can check, not prose that can drift.
// Each entry names three things:
//
//   number      where the figure lives in rules.json — never a literal in code
//   enforcedIn  the file+symbol that actually acts on it
//   strength    what it can really do, in one of three honest words:
//
//     BLOCKS    refuses the action before it happens. Real prevention.
//     REACTS    cannot prevent it; acts immediately afterwards to limit it.
//     ADVISORY  says something. Changes nothing on its own.
//
// The distinction matters more than any individual rule. For six months the
// guards were mostly ADVISORY while everyone spoke about them as if they
// BLOCKED, which is exactly how a cap of 2 and a trade of 20 coexisted.
//
// THE CEILING ON ALL OF IT, stated once so nothing implies otherwise:
// every BLOCKS entry governs orders THIS APP places. None of them can stop an
// order typed straight into TradingView, which is how all five of the
// account-killing trades happened. See order-gateway.preventsManualOrders.
//
// TO ADD A RULE: append an entry, point `number` at a real rules.json path,
// point `enforcedIn` at the real symbol, and give it a test. Then run
//   node scripts/risk-protocol-check.js
// which fails if the number is missing, the symbol does not exist, or the test
// file is absent. A rule that cannot pass that check is not in the protocol —
// it is an intention.

'use strict';

const STRENGTH = { BLOCKS: 'BLOCKS', REACTS: 'REACTS', ADVISORY: 'ADVISORY' };

const PROTOCOL = [
  {
    id: 'per-trade-max-loss',
    title: 'No single trade may lose more than the per-trade cap',
    number: 'perTradeMaxLoss',
    enforcedIn: { file: 'server.js', symbol: 'enforcePerTradeStop' },
    module: 'per-trade-stop.js',
    test: 'test/per-trade-stop-latch.test.js',
    strength: STRENGTH.REACTS,
    why: 'The only single change that flips the record: -$1,946 to +$910 across 115 trades, '
       + 'by capping 5 trades (4.3%) that are 56% of all losses.',
    limits: 'Reacts to an open position; it cannot stop the entry. Latched per POSITION with '
          + 'separate breach and blind shots — a per-day latch cost $1,418 and left the -$1,718 '
          + 'trade that killed s2 unprotected.',
  },
  {
    id: 'size-cap',
    title: 'Contracts per entry, adjustable inside a hard ceiling',
    number: 'sizeCap',
    bounds: ['sizeCapMin', 'sizeCapMax'],
    enforcedIn: { file: 'trade-confirm-rules.js', symbol: 'checkTradeAllowed' },
    module: 'stage-rules.js',
    test: 'test/size-cap-bounds.test.js',
    strength: STRENGTH.BLOCKS,
    why: 'A 20-lot went out against a cap of 2 on 2026-09-03. The ceiling is applied in '
       + 'getActiveRules() after every other layer, so no overlay, hand-edit or UI message '
       + 'can produce an effective cap above sizeCapMax.',
    limits: 'A survival device, not a profit device: measured, the cap ALONE is -$943 while the '
          + 'per-trade stop alone is +$910, and both together are worse than the stop alone, '
          + 'because scaling size down shrinks the winners too.',
  },
  {
    id: 'size-floor',
    title: 'Never trade below the minimum size',
    number: 'sizeFloor',
    enforcedIn: { file: 'trade-confirm-rules.js', symbol: 'checkTradeAllowed' },
    test: 'test/trade-confirm-rules.test.js',
    strength: STRENGTH.BLOCKS,
    why: 'One-contract trades lose in both stages: eval 25% win rate / -$361, funded 54% but '
       + 'still -$345. Sizing down to 1 is what hesitation looks like in the ledger.',
  },
  {
    id: 'size-up-after-loss',
    title: 'Never increase size after a loss',
    number: null,
    enforcedIn: { file: 'trade-confirm-rules.js', symbol: 'sizeUpAfterLossViolation' },
    module: 'renderer/size-freeze-guard.js',
    test: 'test/size-freeze-guard.test.js',
    strength: STRENGTH.BLOCKS,
    why: 'The account killer. The 150K eval breach was 5 lots doubled to 10 while down; s2 was '
       + '4 -> 15 -> 20. failure-chain.js attributes 77% of the 2026-09-03 damage to it.',
  },
  {
    id: 'daily-loss-hard-tier',
    title: 'The hard daily-loss tier ends the session',
    number: 'dailyLossTiers.hard',
    enforcedIn: { file: 'trade-confirm-rules.js', symbol: 'checkTradeAllowed' },
    test: 'test/trade-confirm-rules.test.js',
    strength: STRENGTH.BLOCKS,
    why: 'This account type has NO broker-side daily loss limit. Nothing outside this app stops '
       + 'a bad day until the whole drawdown is gone.',
  },
  {
    id: 'day-stop',
    title: 'Stop trading at the day-stop',
    number: 'dayStop.eval',
    enforcedIn: { file: 'trade-confirm-rules.js', symbol: 'checkTradeAllowed' },
    test: 'test/trade-confirm-rules.test.js',
    strength: STRENGTH.BLOCKS,
  },
  {
    id: 'trades-per-day',
    title: 'Cap the number of trades in a day',
    number: 'tradesPerDay',
    enforcedIn: { file: 'trade-confirm-rules.js', symbol: 'checkTradeAllowed' },
    test: 'test/trade-confirm-rules.test.js',
    strength: STRENGTH.BLOCKS,
    why: 'Ten legal 2-lot trades is twenty contracts — every one inside the rules, day already lost.',
  },
  {
    id: 'drawdown-headroom',
    title: 'Reduce size near the drawdown floor; stand down at it',
    number: 'drawdownGuard.reduceAt',
    bounds: ['drawdownGuard.standDownAt'],
    enforcedIn: { file: 'trade-confirm-rules.js', symbol: 'checkTradeAllowed' },
    module: 'drawdown-guard.js',
    test: 'test/account-floor.test.js',
    strength: STRENGTH.BLOCKS,
    why: 's1 closed $9.44 above its floor on 2026-08-28 and was archived breached the next '
       + 'morning. The floor was computed in four places in the renderer and compared against '
       + 'the balance in none of them.',
    limits: 'Tested against both real account deaths, it fires at trade 6 on each — too late to '
          + 'have saved either. Both days opened with the full $2,000 and lost it in one session. '
          + 'This is a last line for gradual erosion, NOT a substitute for the per-trade stop.',
  },
  {
    id: 'oversize-reduce',
    title: 'Reduce a position that is already over the cap',
    number: 'oversizeGuard.enabled',
    enforcedIn: { file: 'server.js', symbol: 'enforceOversizeGuard' },
    module: 'oversize-guard.js',
    test: 'test/oversize-guard.test.js',
    strength: STRENGTH.REACTS,
    why: 'Oversize cost 72% of the 50K drawdown in a single session. Reduce-to-cap keeps the '
       + 'thesis and removes only the excess risk.',
    limits: 'Only acts under the LIVE ORDERS launcher, and only on a READABLE positions table. '
          + 'An unreadable panel looks identical to a flat account.',
  },
  {
    id: 'order-gateway',
    title: 'One decision governs every order the app places',
    number: null,
    enforcedIn: { file: 'server.js', symbol: 'placeMarketOrder' },
    module: 'order-gateway.js',
    test: 'test/order-gateway.test.js',
    strength: STRENGTH.BLOCKS,
    why: 'Three call sites reached the broker directly, each with its own idea of what was '
       + 'allowed. On 2026-09-03 the size-freeze HARD STOP fired correctly and had no power to act.',
    limits: 'Risk-REDUCING orders (reduce/flatten) are deliberately never blocked — a day-stop '
          + 'must not trap an open position. Cannot prevent a manual TradingView order.',
  },
  {
    id: 'account-snapshot',
    title: 'No account record is destroyed without a copy outside the blast radius',
    number: null,
    enforcedIn: { file: 'server.js', symbol: 'dataWipeAccount' },
    module: 'account-snapshot.js',
    test: 'test/account-snapshot.test.js',
    strength: STRENGTH.BLOCKS,
    why: 'DATA/accounts/s1 was emptied at 18:56 on 2026-09-04 — ten days of trades and all ten '
       + '.bak files, because every backup lived inside the folder being deleted.',
  },
  {
    id: 'cooldown-after-loss',
    title: 'Mandatory break after a loss',
    number: 'cooldownMinutes',
    enforcedIn: { file: 'renderer/app.js', symbol: 'grIngestLive' },
    test: 'test/day-pnl.test.js',
    strength: STRENGTH.ADVISORY,
    why: 'The trade immediately after a loss: 42% win rate, -$1,197 across 24 trades, with '
       + 'average size RISING.',
    limits: 'Displays a countdown. Nothing refuses a trade taken during it.',
  },
  {
    id: 'edge-window',
    title: 'Trade only inside the measured edge window',
    number: 'edgeWindow',
    enforcedIn: { file: 'server.js', symbol: 'armSetup' },
    module: 'edge-window.js',
    test: 'test/edge-window.test.js',
    strength: STRENGTH.ADVISORY,
    why: 'Pooled over 151 trades: 18:00-20:00 IST is +$909; 12:00-17:00 is -$719 with every '
       + 'hour negative.',
    limits: 'Flags a signal as outside-edge. Does not refuse the trade.',
  },
  {
    id: 'consistency-rule',
    title: 'No single day may exceed the consistency share of total profit',
    number: 'payout.tiers.selectEval.consistencyPct',
    enforcedIn: { file: 'payout-eligibility.js', symbol: 'computePayoutEligibility' },
    test: 'test/payout-eligibility.test.js',
    strength: STRENGTH.ADVISORY,
    why: 'The firm gate on the whole goal. Passing the target with one big day still fails a '
       + 'payout at 40%.',
    limits: 'Reports eligibility. Nothing stops a day that breaks it.',
  },
];

/** Every rule that genuinely refuses an action. */
function blocking() { return PROTOCOL.filter((r) => r.strength === STRENGTH.BLOCKS); }
/** Rules that only speak — the honest list of what will not stop him. */
function advisory() { return PROTOCOL.filter((r) => r.strength === STRENGTH.ADVISORY); }
function byId(id) { return PROTOCOL.find((r) => r.id === id) || null; }

/** Resolve a dotted rules.json path, e.g. 'dailyLossTiers.hard'. */
function resolveNumber(rules, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), rules);
}

module.exports = { PROTOCOL, STRENGTH, blocking, advisory, byId, resolveNumber };
