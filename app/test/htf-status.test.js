'use strict';
// ── The hourly "which side are the watchers looking?" evidence (2026-09-02) ─
//
// Anoop asked for this so he can "know they are active and confirm if they are
// doing their work accurately". That second half is the whole test surface: a
// status line that always prints the same confident sentence proves nothing,
// because a server with a dead chart feed prints it too. These pin the parts
// that make the line falsifiable — the bar it was read from, its age, and how
// many watchers are actually armed.
const test = require('node:test');
const assert = require('node:assert');
const hs = require('../htf-status.js');

const MIN = 60 * 1000;
const NOW = Date.parse('2026-09-02T06:30:00Z');   // 12:00 IST
const ALL = [
  { label: '1H', running: true }, { label: '30M', running: true },
  { label: '15M', running: true }, { label: '5M', running: true },
];
// 2026-09-03: the deciding chart is the 15M and the 1H confirms it — see
// htf-alignment.js. The fixture moves with it; the requirement did not change.
const read = (o) => Object.assign({ ok: true, bias: 'bearish', structure15m: 'bearish', structure1h: 'bearish', confirmation: 'confirmed', reason: 'aligned' }, o);
const build = (o) => hs.buildStatus(Object.assign({
  htf: read(), watchers: ALL, nowMs: NOW, lastBarMs: NOW - 30 * MIN,
}, o));

test('it names the side, both structures, and how the 1H voted', () => {
  const s = build();
  assert.equal(s.side, 'BEARISH');
  assert.equal(s.ok, true);
  assert.match(s.evidence, /looking BEARISH/);
  assert.match(s.evidence, /15M structure LL-LH/);
  assert.match(s.evidence, /1H LL-LH, which CONFIRMS it/);
  assert.match(s.headline, /HTF BEARISH/);
});

test('the bullish side reads HH-HL, not the bearish template', () => {
  const s = build({ htf: read({ bias: 'bullish', structure15m: 'bullish', structure1h: 'bullish' }) });
  assert.match(s.evidence, /looking BULLISH/);
  assert.match(s.evidence, /15M structure HH-HL/);
});

// ── The part that makes it EVIDENCE rather than decoration ────────────────
test('it names the candle it read, so he can check it against his own chart', () => {
  // 11:45 IST — one 15M bar behind NOW, the designed lag. It was 11:00 when
  // the read was hourly; against a 15M read that is four missed closes and the
  // line correctly leads with STALE instead, which would hide what this test
  // is actually about.
  const s = build({ lastBarMs: Date.parse('2026-09-02T06:15:00Z') });
  assert.equal(s.barCloseIST, '11:45');
  assert.match(s.evidence, /Read from 15M bars up to 11:45 IST/);
  assert.match(s.evidence, /check that candle against your chart/);
});

test('a STALE read leads with the staleness, not with the side', () => {
  const s = build({ lastBarMs: NOW - 200 * MIN });
  assert.equal(s.stale, true);
  // the bias must still be reported — hiding it is its own failure — but the
  // line must not open as though it were current
  assert.match(s.evidence, /^HTF [\d:]+ IST — STALE READ/);
  assert.match(s.evidence, /do not trust this side/);
  assert.match(s.evidence, /chart feed has probably stalled/);
  assert.match(s.evidence, /Last computed side was BEARISH/);
  assert.match(s.headline, /HTF STALE/);
});

test('one bar of lag is NORMAL and must not cry stale', () => {
  // readHTF drops the forming bar by design, so it is always ~1 bar behind.
  const s = build({ lastBarMs: NOW - 16 * MIN });
  assert.equal(s.stale, false, 'a single 15M bar of lag is the designed state');
  assert.doesNotMatch(s.evidence, /STALE/);
});

// The threshold TRACKS the deciding timeframe (2026-09-03). Two 15M closes
// plus a margin, not the 125 minutes that was two 1H closes. Left at 125, a
// stalled feed would have gone eight closes unreported — so this pins that a
// 40-minute-old read is already stale, which under the old constant it was not.
test('a stalled feed shows an AGEING number, not a repeated confident sentence', () => {
  const ages = [10, 30, 40, 120].map(m => build({ lastBarMs: NOW - m * MIN }));
  const texts = ages.map(s => s.evidence);
  assert.equal(new Set(texts).size, texts.length, 'each check must read differently');
  assert.deepEqual(ages.map(s => s.stale), [false, false, true, true]);
});

// ── "are they active" ─────────────────────────────────────────────────────
test('all watchers armed is stated with the count AND the names', () => {
  const s = build();
  assert.equal(s.armedCount, 4);
  assert.match(s.evidence, /All 4 engulf watchers armed \(1H, 30M, 15M, 5M\)/);
});

test('a DOWN watcher is named, because "3 of 4" does not say which blind spot', () => {
  const s = build({ watchers: [
    { label: '1H', running: true }, { label: '30M', running: true },
    { label: '15M', running: false }, { label: '5M', running: true },
  ] });
  assert.equal(s.armedCount, 3);
  assert.deepEqual(s.missingWatchers, ['15M']);
  assert.match(s.evidence, /WARNING: only 3 of 4 watchers armed — 15M is DOWN/);
});

test('every watcher down is an explicit "nothing is being monitored"', () => {
  const s = build({ watchers: ALL.map(w => ({ label: w.label, running: false })) });
  assert.match(s.evidence, /NO engulf watchers are running — nothing is being monitored/);
});

// ── the refusal cases ─────────────────────────────────────────────────────
// 2026-09-03: "nothing may fire" stopped being true when Playbook A was
// ungated. The line must name WHICH playbooks are held, because a status that
// overstates what the app is blocking is the same failure class as one that
// overstates what it is watching.
test('no bias says which playbooks are held, and does not overstate it', () => {
  const s = build({ htf: { ok: false, structure15m: 'unclear', reason: 'htf-15m-unclear' } });
  assert.equal(s.ok, false);
  assert.equal(s.side, 'NO SIDE');
  assert.match(s.evidence, /NO BIAS/);
  assert.match(s.evidence, /Playbook B and Playbook C \(ADX\) are held/);
  assert.match(s.evidence, /Playbook A still alerts/);
  assert.doesNotMatch(s.evidence, /Nothing may fire on any playbook/);
  assert.match(s.evidence, /15M structure reads unclear/);
});

test('a totally failed read does not masquerade as a neutral market', () => {
  const s = hs.buildStatus({ htf: null, watchers: ALL, nowMs: NOW, lastBarMs: null });
  assert.equal(s.ok, false);
  assert.match(s.evidence, /could not be read at all/);
  assert.equal(s.barCloseIST, null);
  assert.equal(s.dataAgeMinutes, null);
});

test('a 15M-only fire is labelled as such in the hourly line too', () => {
  const dis = build({ htf: read({ structure1h: 'bullish', confirmation: 'disagrees' }) });
  assert.match(dis.evidence, /DISAGREES — these are 15M-only trades/);
  const unc = build({ htf: read({ structure1h: 'unclear', confirmation: 'unclear' }) });
  assert.match(unc.evidence, /unclear, so it does not confirm — these are 15M-only trades/);
  const una = build({ htf: read({ structure1h: null, confirmation: 'unavailable' }) });
  assert.match(una.evidence, /unavailable, not read — these are 15M-only trades/);
});

// The rule being applied is no longer the same for every playbook, so the line
// has to distinguish them. "Only BEARISH setups can fire" would be a plain
// misstatement of what the engulf watchers now do.
test('it states the rule per playbook, since A and B/C no longer share one', () => {
  const e = build().evidence;
  assert.match(e, /Playbook B and Playbook C \(ADX\) can only fire BEARISH/);
  assert.match(e, /Playbook A alerts BOTH ways/);
  assert.doesNotMatch(e, /Only BEARISH setups can fire/);
});

test('missing inputs degrade to a printable line rather than throwing', () => {
  for (const arg of [undefined, {}, { htf: {}, watchers: null }]) {
    const s = hs.buildStatus(arg);
    assert.equal(typeof s.evidence, 'string');
    assert.ok(s.evidence.length > 0);
    assert.equal(typeof s.headline, 'string');
  }
});
