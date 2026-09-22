'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildAccounts, statusOf, nextAccountId } = require('../accounts-index');

const SLOT = (over) => Object.assign({ id: 's1', name: 'Account 1', size: '50k', stage: 'eval' }, over || {});
const PEEK = (over) => Object.assign({ bal: 50000, floor: 48000, breached: false, days: 0, lastDate: null, firstDate: null }, over || {});

// ── statusOf ───────────────────────────────────────────────────────────────
test('a retired slot is breached even when its ledger reads healthy', () => {
  // Exactly his s2: retired by the auto-detect, ledger above the floor.
  assert.equal(statusOf(SLOT({ retired: true }), PEEK({ bal: 48732, floor: 48122, days: 5 })), 'breached');
});

test('a ledger under the floor is breached even when the flag is missing', () => {
  assert.equal(statusOf(SLOT(), PEEK({ bal: 47000, floor: 48122, breached: true, days: 3 })), 'breached');
});

test('the flag outranks an explicit active status', () => {
  assert.equal(statusOf(SLOT({ retired: true, status: 'active' }), PEEK({ days: 9 })), 'breached');
});

test('traded data with no breach reads active; no data reads empty', () => {
  assert.equal(statusOf(SLOT(), PEEK({ days: 4 })), 'active');
  assert.equal(statusOf(SLOT(), PEEK({ days: 0 })), 'empty');
  assert.equal(statusOf(SLOT(), null), 'empty');
});

test('an explicit slot status is a declaration, and outranks the data', () => {
  assert.equal(statusOf(SLOT({ status: 'cleared' }), PEEK({ days: 2 })), 'cleared');
  assert.equal(statusOf(SLOT({ status: 'breached' }), PEEK({ days: 2 })), 'breached');
  // 'funded' is not a claim that an account has finished — it describes the
  // stage, so with no live data the slot reports funded, and with live data the
  // stage field decides (an eval slot that says 'funded' is contradictory input
  // and the stage is the field every profile calculation actually uses).
  assert.equal(statusOf(SLOT({ status: 'funded' }), PEEK({ days: 0 })), 'funded');
  assert.equal(statusOf(SLOT({ stage: 'funded' }), PEEK({ days: 3 })), 'funded');
});

test('an account sealed by "Start new account" reads closed, not live', () => {
  // He seals the account he is leaving and opens a new one. The old slot keeps
  // its data on disk, so without the closedAt declaration it would still be
  // presented as the live account he is trading.
  assert.equal(statusOf(SLOT({ closedAt: '2026-09-20' }), PEEK({ days: 9 })), 'closed');
  const r = buildAccounts({
    slots: [SLOT({ id: 's2', name: 'Apex new EOD', closedAt: '2026-09-20' })],
    peeks: { s2: PEEK({ bal: 48732, days: 7 }) },
  });
  assert.equal(r.accounts[0].closedOn, '2026-09-20');
  assert.equal(r.accounts[0].viewOnly, false, 'closed is not breached — he can still open it');
  assert.equal(r.summary.closed, 1);
});

// ── buildAccounts ──────────────────────────────────────────────────────────
test('ARCHIVES DO NOT SET STATUS — an old breach record cannot kill a live account', () => {
  // His s5 carries a 'breached' archive record from 2026-09-04 and is a live
  // $148k funded account today. Letting the archive list decide the status
  // would label a live account dead.
  const r = buildAccounts({
    slots: [SLOT({ id: 's5', name: 'Account 5', size: '150k', stage: 'funded' })],
    peeks: { s5: PEEK({ bal: 148459, floor: 145500, days: 12, lastDate: '2026-03-09' }) },
    archives: [{ slotId: 's5', archivedAt: '2026-09-04T07:03:42Z', event: 'breached', label: 'paper EVAL' }],
  });
  // A live FUNDED account reports 'funded' — the stage is part of the status,
  // and it sorts with the active accounts either way.
  assert.equal(r.accounts[0].status, 'funded');
  assert.equal(r.accounts[0].viewOnly, false);
  assert.equal(r.accounts[0].periods, 1, 'the period is still reported as history');
});

test('every slot is returned — nothing is filtered out', () => {
  const r = buildAccounts({
    slots: [SLOT({ id: 's1', retired: true }), SLOT({ id: 's2', retired: true }), SLOT({ id: 's3' })],
    peeks: { s1: PEEK({ days: 0 }), s2: PEEK({ days: 5 }), s3: PEEK({ days: 0 }) },
    activeId: 's2',
  });
  assert.equal(r.accounts.length, 3);
  assert.equal(r.summary.breached, 2);
  assert.equal(r.summary.empty, 1);
});

test('a breached account is view-only and carries a final balance', () => {
  const r = buildAccounts({
    slots: [SLOT({ id: 's2', name: 'Apex new EOD', retired: true, retiredAt: '2026-09-18' })],
    peeks: { s2: PEEK({ bal: 48732.28, days: 5, lastDate: '2026-09-17' }) },
  });
  const a = r.accounts[0];
  assert.equal(a.status, 'breached');
  assert.equal(a.viewOnly, true);
  assert.equal(a.balanceLabel, '$48,732');
  assert.equal(a.closedOn, '2026-09-18');
  assert.equal(a.days, 5);
  assert.equal(a.lastTraded, '2026-09-17');
});

test('a breached slot whose ledger was wiped falls back to the recorded breach balance', () => {
  const r = buildAccounts({
    slots: [SLOT({ id: 's9', retired: true, retiredAt: '2026-09-01', retiredBalance: 47600.5 })],
    peeks: {},
  });
  const a = r.accounts[0];
  assert.equal(a.status, 'breached');
  assert.equal(a.balanceLabel, '$47,601');
});

test('an empty account says so instead of showing a fake balance', () => {
  const r = buildAccounts({ slots: [SLOT({ id: 's3' })], peeks: { s3: PEEK({ days: 0 }) } });
  assert.equal(r.accounts[0].balanceLabel, 'Empty — no data yet');
  assert.equal(r.accounts[0].status, 'empty');
});

test('the active account sorts first, then most-recently-alive, empties last', () => {
  const r = buildAccounts({
    slots: [
      SLOT({ id: 's3' }),
      SLOT({ id: 's1', retired: true, retiredAt: '2026-09-05' }),
      SLOT({ id: 's2', name: 'Apex new EOD', retired: true, retiredAt: '2026-09-18' }),
      SLOT({ id: 's4' }),
    ],
    peeks: {
      s1: PEEK({ bal: 50122, days: 3, lastDate: '2026-09-04' }),
      s2: PEEK({ bal: 48732, days: 5, lastDate: '2026-09-17' }),
      s3: PEEK({ days: 0 }), s4: PEEK({ days: 0 }),
    },
    activeId: 's2',
  });
  const ids = r.accounts.map(a => a.id);
  assert.equal(ids[0], 's2', 'the open account is first');
  assert.equal(ids[1], 's1', 'then the more recent breach');
  assert.equal(ids[2], 's3');
  assert.equal(ids[3], 's4');
});

test('the firm comes from the account own Cost row when there is one', () => {
  const r = buildAccounts({
    slots: [SLOT({ id: 's2', name: 'Apex new EOD', retired: true })],
    peeks: { s2: PEEK({ days: 5 }) },
    fees: [{ slotId: 's2', firm: 'Apex', date: '2026-09-07' }, { slotId: 's2', firm: 'Lucid', date: '2026-09-18' }],
  });
  assert.equal(r.accounts[0].firm, 'Lucid', 'the most recent cost row wins');
});

test('the footer says closed to trading, never hidden', () => {
  const r = buildAccounts({
    slots: [SLOT({ id: 's1', retired: true }), SLOT({ id: 's2', retired: true })],
    peeks: { s1: PEEK({ days: 0 }), s2: PEEK({ days: 0 }) },
  });
  assert.match(r.summary.footer, /2 breached accounts/);
  assert.match(r.summary.footer, /closed to trading/);
  assert.doesNotMatch(r.summary.footer, /hidden/);
});

test('no breached accounts means a footer that still promises full visibility', () => {
  const r = buildAccounts({ slots: [SLOT({ id: 's1' })], peeks: { s1: PEEK({ days: 1 }) } });
  assert.match(r.summary.footer, /Nothing is hidden/);
});

test('survives junk input rather than throwing into the picker', () => {
  assert.deepEqual(buildAccounts({}).accounts, []);
  assert.deepEqual(buildAccounts(null).accounts, []);
  assert.equal(buildAccounts({ slots: [null, undefined, SLOT({ id: 's1' })], peeks: {} }).accounts.length, 1);
});

// ── sealed records (CLOSED_<status>.json in the account's own folder) ──────
test('with no live data the seal describes the account, not the stale mirror', () => {
  // His s5: the disk folder holds no ledger, the config mirror advertises a
  // $148k/150K account, and the seal says it was a 50K funded "paper" account
  // with 10 days and $49,594.66. The seal is the truth.
  const r = buildAccounts({
    slots: [SLOT({ id: 's5', name: 'Account 5', size: '150k', stage: 'funded' })],
    peeks: { s5: PEEK({ bal: 148459, days: 0 }) },
    closed: { s5: { status: 'breached', finalBalance: 49594.66, daysTraded: 10, closedOn: '2026-09-04', name: 'paper', size: '50k', stage: 'funded', ledger: { '2026-08-24': {}, '2026-08-25': {} } } },
  });
  const a = r.accounts[0];
  assert.equal(a.status, 'breached');
  assert.equal(a.balanceLabel, '$49,595');
  assert.equal(a.days, 10);
  assert.equal(a.closedOn, '2026-09-04');
  assert.equal(a.openedOn, '2026-08-24', 'opened from the sealed ledger');
  assert.equal(a.lastPeriodLabel, '$50K FUNDED', 'the mismatch with the slot is stated, not hidden');
});

test('live data beats a stale seal — an eval that cleared into funded keeps trading', () => {
  const r = buildAccounts({
    slots: [SLOT({ id: 's7', size: '50k', stage: 'funded' })],
    peeks: { s7: PEEK({ bal: 51200, days: 6, lastDate: '2026-09-18' }) },
    closed: { s7: { status: 'cleared', finalBalance: 53000, daysTraded: 12, closedOn: '2026-09-01' } },
  });
  assert.equal(r.accounts[0].status, 'funded');
  assert.equal(r.accounts[0].balanceLabel, '$51,200', 'the live balance, not the sealed one');
  assert.equal(r.accounts[0].days, 6);
});

test('a retired slot still outranks live data', () => {
  const r = buildAccounts({
    slots: [SLOT({ id: 's2', name: 'Apex new EOD', retired: true, retiredAt: '2026-09-18' })],
    peeks: { s2: PEEK({ bal: 48732, days: 7, lastDate: '2026-09-17' }) },
    closed: { s2: { status: 'breached', finalBalance: 48118.86, daysTraded: 26, closedOn: '2026-09-18' } },
  });
  assert.equal(r.accounts[0].status, 'breached');
  assert.equal(r.accounts[0].days, 7, 'live days are still shown: the folder has them');
  assert.equal(r.accounts[0].balanceLabel, '$48,732');
});

test('a live balance that disagrees with the seal is explained, not hidden', () => {
  const r = buildAccounts({
    slots: [SLOT({ id: 's2', name: 'Apex new EOD', retired: true, retiredAt: '2026-09-18' })],
    peeks: { s2: PEEK({ bal: 48732, days: 7 }) },
    closed: { s2: { status: 'breached', finalBalance: 48118.86, daysTraded: 26, closedOn: '2026-09-18' } },
  });
  assert.equal(r.accounts[0].balanceLabel, '$48,732');
  assert.match(r.accounts[0].sealedNote, /sealed record: \$48,119 over 26d, closed 2026-09-18/);
});

test('no note is produced when the two sources agree', () => {
  const r = buildAccounts({
    slots: [SLOT({ id: 's2', retired: true })],
    peeks: { s2: PEEK({ bal: 48119, days: 3 }) },
    closed: { s2: { status: 'breached', finalBalance: 48118.86, daysTraded: 26, closedOn: '2026-09-18' } },
  });
  assert.equal(r.accounts[0].sealedNote, null);
});

// ── nextAccountId ──────────────────────────────────────────────────────────
test('a new account id is derived from its start date', () => {
  assert.equal(nextAccountId([], '2026-09-20'), 'a20260920');
  assert.equal(nextAccountId(['s1', 's2'], '2026-09-20'), 'a20260920');
});

test('two accounts opened the same day cannot collide', () => {
  const first = nextAccountId(['s1'], '2026-09-20');
  const second = nextAccountId(['s1', first], '2026-09-20');
  assert.equal(first, 'a20260920');
  assert.equal(second, 'a20260920a');
  assert.notEqual(first, second);
});

test('a missing date still produces a usable id', () => {
  assert.equal(nextAccountId([], ''), 'aacct');
  assert.equal(nextAccountId([], null), 'aacct');
});
