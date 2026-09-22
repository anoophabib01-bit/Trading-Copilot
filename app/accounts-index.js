'use strict';
/* ── accounts-index.js — every account the app knows about, nothing hidden ───
 * 2026-09-19. Anoop, looking at the picker: "the account screenshot says 2
 * breached accounts hidden. i don't know why they are hidden... i do not want
 * to hide anything and want to see the account that is actually breached until
 * new account is started."
 *
 * WHY THEY WERE HIDDEN: on 2026-07-25 he asked for exactly that — "do not show
 * any account that is already breached... the details of breached should be
 * added as cost session." The app implemented it literally: a breach sets
 * slot.retired, and the picker rendered acctSlots.filter(s => !s.retired), so
 * the only trace left was a count in the footer. The instruction made sense at
 * the time (a breached account is closed to trading) but the implementation
 * threw away the VISIBILITY along with the tradeability.
 *
 * WHAT THIS MODULE IS: the one derivation that turns slots + their disk peeks +
 * their archive records into a list of ACCOUNTS with a status, so the picker,
 * the footer and any future surface read the same picture. Pure — no fs, no
 * clock, no app state — so the rules about what counts as breached/active/empty
 * are testable without a running app (same split as pattern-memory.js).
 *
 * DELIBERATELY NOT PERSISTED. A stored accounts_index.json would be one more
 * file that can drift from the data it describes, and this repo has paid for
 * that pattern repeatedly (a stale balance in a persona, a config mirror that
 * disagreed with disk). The index is derived on demand from the same sources
 * the rest of the app already reads.
 *
 * ARCHIVES DO NOT SET STATUS. A slot can carry an old 'breached' archive record
 * and still be trading today (s5 does: a "paper EVAL" breach on 2026-09-04,
 * with a live $148k balance since). Letting the archive list decide the status
 * would label a live account dead. Archive records are reported as PERIODS —
 * history, not current state.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AccountsIndex = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIZE_LABELS = { '50k': '$50K', '100k': '$100K', '150k': '$150K' };

  const num = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null; }
    return null;
  };
  const money = (n) => {
    const v = num(n);
    if (v == null) return null;
    return (v < 0 ? '-$' : '$') + Math.abs(Math.round(v)).toLocaleString('en-US');
  };

  /**
   * What is this account's state RIGHT NOW?
   *
   * Order matters and each step is deliberate:
   *   1. slot.retired      — the explicit "this account is dead" flag the app
   *                          sets on breach (auto-detected or manual). It is
   *                          the only reason the picker used to hide a row, so
   *                          it is the primary source here too.
   *   2. peek.breached     — the ledger itself says the balance went under the
   *                          floor. Catches a breach the flag has not recorded
   *                          yet (the auto-detect runs on picker open).
   *   3. slot.status       — an explicit status written by the clear/payout
   *                          flows ('cleared', 'funded').
   *   4. peek.days > 0     — traded data exists, so the account is live.
   *   5. otherwise         — empty.
   */
  function statusOf(slot, peek, closed) {
    const s = slot || {};
    const p = peek || null;
    const c = closed || null;
    // THREE SOURCES, TWO DIFFERENT KINDS OF CLAIM — the order is the design:
    //   * the slot (retired flag, explicit status) is a DECLARATION about the
    //     account, and declarations win over data;
    //   * the sealed CLOSED_*.json is a RECORD of a period that ended, so it
    //     loses to live data — an eval cleared into funded keeps its old
    //     CLOSED_cleared.json in the same folder while it trades on.
    // 1. The app's own "this account is dead" flag.
    if (s.retired) return 'breached';
    // 2. SEALED BY "Start new account" — the slot carries a closedAt but is not
    //    breached. It still has data on disk, so without this it would keep
    //    reading as the live account even though the trader has moved on to a
    //    new one. A declaration, like the status below, and it wins over data.
    if (s.closedAt) return 'closed';
    // 3. An explicit status on the slot itself.
    const explicit = s.status ? String(s.status).toLowerCase() : null;
    if (explicit === 'breached') return 'breached';
    if (explicit === 'cleared') return 'cleared';
    // 3. The ledger itself is under the floor.
    if (p && p.breached) return 'breached';
    // 4. Live data on disk means the account is alive now.
    if (p && num(p.days) > 0) return String(s.stage || '').toLowerCase() === 'funded' ? 'funded' : 'active';
    // 5. No live data: the sealed record in the account's own folder is the last
    //    word on it. This is what makes s5 read as the 50K "paper" funded
    //    account it actually was, rather than the $148k/150K its stale config
    //    mirror has been advertising.
    if (c) {
      const cs = String(c.status || '').toLowerCase();
      if (cs === 'breached') return 'breached';
      if (cs === 'cleared') return 'cleared';
    }
    if (explicit === 'active' || explicit === 'funded') return explicit === 'funded' ? 'funded' : 'active';
    return 'empty';
  }

  const ORDER = { active: 0, funded: 0, cleared: 1, closed: 1, breached: 2, empty: 3 };

  /**
   * @param {object} input
   *   slots    [{id, name, size, stage, startedAt, retired, retiredAt,
   *              retiredBalance, accountId}]
   *   peeks    { slotId: {bal, floor, breached, firstDate, lastDate, days} }
   *   archives [{slotId, archivedAt, event, label}]  (optional)
   *   fees     [{slotId, firm, cost, date}]          (optional)
   *   activeId the currently open slot
   * @returns {{accounts: Array, summary: object}}
   */
  function buildAccounts(input) {
    const o = input || {};
    const slots = Array.isArray(o.slots) ? o.slots.filter(Boolean) : [];
    const peeks = o.peeks || {};
    // { slotId: {status, finalBalance, daysTraded, closedOn, name, size, stage} }
    // — the account's own sealed CLOSED_<status>.json, read from its folder.
    const closed = o.closed || {};
    const archives = Array.isArray(o.archives) ? o.archives : [];
    const fees = Array.isArray(o.fees) ? o.fees : [];
    const activeId = o.activeId || null;

    const accounts = slots.map(function (slot) {
      const peek = peeks[slot.id] || null;
      const sealed = closed[slot.id] || null;
      const status = statusOf(slot, peek, sealed);
      const liveDays = peek && num(peek.days) != null ? num(peek.days) : 0;
      // With no live data, the seal IS the account: its final balance, its day
      // count and its close date are the only figures that describe it.
      const useSealed = !liveDays && !!sealed;
      // A breached slot may have no readable ledger (its folder was wiped by an
      // older "Start fresh"); the balance the app recorded at breach time is
      // then the honest number, and it is labelled as the FINAL one.
      const bal = (useSealed && num(sealed.finalBalance) != null) ? num(sealed.finalBalance)
        : (peek && num(peek.bal) != null ? num(peek.bal)
          : (num(slot.retiredBalance) != null ? num(slot.retiredBalance) : null));
      const sealedFirst = (useSealed && sealed.ledger && typeof sealed.ledger === 'object')
        ? Object.keys(sealed.ledger).sort()[0] : null;
      const openedOn = slot.startedAt || (peek && peek.firstDate) || sealedFirst || slot.retiredAt || null;
      const closedOn = (sealed && sealed.closedOn) || slot.closedAt || slot.retiredAt || null;
      const periods = archives.filter(function (a) { return a && a.slotId === slot.id; });
      // The firm is taken from the account's own Cost-tab row when there is
      // one — the slot itself has never carried a firm, which is how an Apex
      // account came to be logged as Lucid.
      const feeRow = fees.filter(function (f) { return f && f.slotId === slot.id; }).sort(function (a, b) {
        return String(b.date || '') < String(a.date || '') ? -1 : 1;
      })[0] || null;
      const sizeLabel = SIZE_LABELS[slot.size] || String(slot.size || '').toUpperCase();
      const fallbackLabel = (sizeLabel + ' ' + String(slot.stage || '').toUpperCase()).trim();
      return {
        id: slot.id,
        name: slot.name || (sealed && sealed.name) || fallbackLabel,
        label: (slot.name || (sealed && sealed.name) || fallbackLabel),
        firm: (feeRow && feeRow.firm) || slot.firm || null,
        size: slot.size || null,
        stage: slot.stage || null,
        status,
        viewOnly: status === 'breached',
        isActive: slot.id === activeId,
        openedOn,
        closedOn,
        balance: bal,
        // An EMPTY account reports no balance even when a start balance is
        // known: the status already says there is no data, and printing
        // "$50,000" next to it invites the reader to think it traded. The two
        // fields agree or they are both wrong.
        balanceLabel: status === 'empty' ? 'Empty — no data yet'
          : (bal != null ? money(bal) : 'no balance on file'),
        days: (useSealed && num(sealed.daysTraded) != null) ? num(sealed.daysTraded) : liveDays,
        lastTraded: (peek && peek.lastDate) || null,
        // When the slot's own size/stage disagrees with what it last actually
        // traded as, say so rather than showing one and meaning the other.
        // When the live figures and the sealed record disagree, SAY SO. A
        // contradiction left unexplained is what makes an accounts screen
        // untrustworthy; one clause naming the other number removes the doubt.
        sealedNote: (sealed && !useSealed && sealed.finalBalance != null && bal != null
          && Math.abs(Number(sealed.finalBalance) - Number(bal)) > 1)
          ? ('sealed record: ' + money(sealed.finalBalance)
            + (sealed.daysTraded != null ? ' over ' + sealed.daysTraded + 'd' : '')
            + (sealed.closedOn ? ', closed ' + sealed.closedOn : ''))
          : null,
        lastPeriodLabel: (useSealed && sealed.size && (String(sealed.size) !== String(slot.size) || String(sealed.stage) !== String(slot.stage)))
          ? ((SIZE_LABELS[sealed.size] || String(sealed.size).toUpperCase()) + ' ' + String(sealed.stage || '').toUpperCase())
          : null,
        periods: periods.length,
        lastPeriodAt: periods.length ? periods.map(function (p) { return p.archivedAt; }).sort().pop() : null,
        folder: 'accounts/' + slot.id,
      };
    });

    // Active first; then by how recently the account was alive (last traded, or
    // closed date for a breached one); empties last. A list that reorders itself
    // randomly between opens is how "which one am I on" becomes a guess.
    accounts.sort(function (a, b) {
      const ao = ORDER[a.status] != null ? ORDER[a.status] : 9;
      const bo = ORDER[b.status] != null ? ORDER[b.status] : 9;
      if (ao !== bo) return ao - bo;
      const ad = a.isActive ? '9999-99-99' : (a.lastTraded || a.closedOn || a.openedOn || '');
      const bd = b.isActive ? '9999-99-99' : (b.lastTraded || b.closedOn || b.openedOn || '');
      if (ad !== bd) return ad < bd ? 1 : -1;
      return String(a.id) < String(b.id) ? -1 : 1;
    });

    const summary = {
      total: accounts.length,
      active: accounts.filter(function (a) { return a.status === 'active' || a.status === 'funded'; }).length,
      breached: accounts.filter(function (a) { return a.status === 'breached'; }).length,
      cleared: accounts.filter(function (a) { return a.status === 'cleared'; }).length,
      closed: accounts.filter(function (a) { return a.status === 'closed'; }).length,
      empty: accounts.filter(function (a) { return a.status === 'empty'; }).length,
    };
    // The footer line, written here rather than in the renderer so the words and
    // the count can never disagree. Say "closed to trading", never "hidden".
    summary.footer = summary.breached
      ? summary.breached + ' breached account' + (summary.breached === 1 ? '' : 's')
        + ' — closed to trading, data still viewable'
      : 'Switch accounts any time. Nothing is hidden.';
    return { accounts, summary };
  }

  /**
   * The next account id, derived from the date so two accounts opened on the
   * same day cannot collide and the folder name says when it started.
   * '2026-09-20' -> 'a20260920', then 'a20260920b', ... on collision.
   */
  function nextAccountId(existingIds, dateKey) {
    const digits = String(dateKey || '').replace(/[^0-9]/g, '');
    const base = 'a' + (digits || 'acct');
    const used = {};
    (Array.isArray(existingIds) ? existingIds : []).forEach(function (id) { used[String(id)] = true; });
    if (!used[base]) return base;
    for (let i = 1; i < 100; i++) {
      const letter = String.fromCharCode(97 + (i - 1));   // a, b, c...
      const cand = base + letter;
      if (!used[cand]) return cand;
    }
    return base + '-' + Date.now();
  }

  return { buildAccounts, statusOf, nextAccountId, SIZE_LABELS, money };
});
