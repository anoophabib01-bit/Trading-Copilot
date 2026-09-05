// ── The end-of-day trailing drawdown floor (2026-09-04) ──────────────────────
//
// WHY THIS EXISTS
// The floor is the number that ends an evaluation, and until now only the
// RENDERER knew it — computed in four places in renderer/app.js and compared
// against the balance in none of them. The server, which is the only thing that
// can refuse an order, had no idea how close the account was to death.
//
// On 2026-08-28 s1 closed $9.44 above its floor and was archived breached the
// next morning. Nothing in the app could have stopped that, because the process
// holding the order gate could not compute the number.
//
// THE MECHANIC, and the part that is easy to get wrong:
// Tradeify Select is END-OF-DAY trailing. The floor rises with each new peak
// EOD balance and NEVER comes back down. It stops rising once it reaches
// floorLocksAt (start + 100).
//
//   floor = min(floorLocksAt, max(previousFloor, peakEodBalance - maxDrawdown))
//
// The consequence nothing in this app surfaces: below start + maxDrawdown + 100
// ($52,100 on a 50K) the floor follows every gain, so headroom is PINNED at
// $2,000 no matter how well he trades. At $52,100 the floor locks at $50,100 and
// headroom finally grows with the balance. $52,100 — not the $53,000 target — is
// the number that changes the risk profile.
//
// Intraday moves do NOT move the floor (that is what "end-of-day" means), but
// the limit is still enforced in real time — touching it fails the account
// immediately. So the floor is computed from CLOSED days and compared against
// the LIVE balance.
//
// Pure and side-effect-free: the server, the renderer and the tests share one
// definition rather than the four that drifted before.

/**
 * Walk the closed-day nets and return the trailing floor as it stands now.
 *
 * @param {object} o
 * @param {number} o.start           account starting balance
 * @param {number} o.maxDrawdown     the drawdown allowance (2000 on a 50K)
 * @param {number} [o.floorLocksAt]  where the floor stops trailing (start+100)
 * @param {number[]} [o.dailyNets]   closed-day net P&L, oldest first
 * @returns {{floor:number|null, peakBalance:number|null, locked:boolean, balanceAfterClosedDays:number|null}}
 */
function computeTrailingFloor(o) {
  const opts = o || {};
  const start = Number(opts.start);
  const dd = Number(opts.maxDrawdown);
  if (!Number.isFinite(start) || !Number.isFinite(dd) || dd <= 0) {
    return { floor: null, peakBalance: null, locked: false, balanceAfterClosedDays: null };
  }
  const lock = Number.isFinite(Number(opts.floorLocksAt)) ? Number(opts.floorLocksAt) : (start + 100);
  const nets = Array.isArray(opts.dailyNets) ? opts.dailyNets : [];

  let bal = start;
  let floor = start - dd;
  let peak = start;
  for (const n of nets) {
    const v = Number(n);
    if (!Number.isFinite(v)) continue;      // a corrupt row must not zero the walk
    bal += v;
    if (bal > peak) peak = bal;
    // The floor only ever ratchets UP, and stops at the lock.
    floor = Math.min(lock, Math.max(floor, bal - dd));
  }
  return {
    floor: Math.round(floor * 100) / 100,
    peakBalance: Math.round(peak * 100) / 100,
    locked: floor >= lock,
    balanceAfterClosedDays: Math.round(bal * 100) / 100,
  };
}

/**
 * The balance at which the floor stops trailing and headroom starts growing.
 * Surfaced because it is the real milestone and nothing in the app shows it.
 */
function headroomUnlockBalance(o) {
  const opts = o || {};
  const start = Number(opts.start);
  const dd = Number(opts.maxDrawdown);
  if (!Number.isFinite(start) || !Number.isFinite(dd)) return null;
  const lock = Number.isFinite(Number(opts.floorLocksAt)) ? Number(opts.floorLocksAt) : (start + 100);
  return Math.round((lock + dd) * 100) / 100;
}

/**
 * Strict numeric read. `Number(null)` is 0 and `Number('')` is 0, so a plain
 * Number() here turns a MISSING balance into a real one — and an absent balance
 * would compute headroom of -$49,000 and stand the account down on nothing.
 * Caught by this module's own test; a missing value must stay missing.
 */
function strictNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Convenience: the two numbers the order gate needs, from raw inputs. */
function floorAndHeadroom(o) {
  const opts = o || {};
  const f = computeTrailingFloor(opts);
  const balance = strictNum(opts.liveBalance);
  const headroom = (f.floor != null && balance != null) ? Math.round((balance - f.floor) * 100) / 100 : null;
  return { floor: f.floor, balance, headroom, locked: f.locked, peakBalance: f.peakBalance };
}

module.exports = { computeTrailingFloor, headroomUnlockBalance, floorAndHeadroom };
