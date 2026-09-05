'use strict';
/**
 * journal-notes.js tests.
 *
 * 2026-08-25, Anoop: "everything that i put in journal will be lesson and
 * should come to be in coaching in chat tomorrow and help me stick to this."
 * The Journal's fields were write-only — saved to notes.json and read by
 * nothing but the tab that wrote them.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const jn = require('../journal-notes');
const fs = require('fs');
const path = require('path');

// His real 2026-08-25 entry, typed into the app.
const REAL = {
  '2026-08-25': {
    mood: 'overconfident',
    followedPlan: 'no',
    mistake: 'held loser',
    text: 'started with 5 size which killed my confidence after first loss trade and later oversized to recover everything since i have not taken any loss days on this account',
    lesson: 'start small for tomorrow',
  },
};

test('formatJournalContext: his own lesson leads, verbatim and in quotes', () => {
  const out = jn.formatJournalContext(REAL, '2026-08-26');
  assert.ok(out.includes('"start small for tomorrow"'), out);
  assert.ok(/written at the close of 2026-08-25/.test(out), out);
  // The whole point is that it stays HIS sentence.
  assert.ok(/in HIS words/.test(out), out);
});

test('formatJournalContext: carries mood, plan adherence and the named mistake', () => {
  const out = jn.formatJournalContext(REAL, '2026-08-26');
  assert.ok(out.includes('felt overconfident'), out);
  assert.ok(out.includes('did NOT follow his plan'), out);
  assert.ok(out.includes('main mistake: held loser'), out);
  assert.ok(out.includes('oversized to recover'), 'his own words must survive');
});

test("formatJournalContext: today's own note is excluded, not echoed back mid-session", () => {
  assert.strictEqual(jn.formatJournalContext(REAL, '2026-08-25'), '');
});

test('formatJournalContext: empty when nothing has been journalled', () => {
  assert.strictEqual(jn.formatJournalContext({}, '2026-08-26'), '');
  assert.strictEqual(jn.formatJournalContext(null, '2026-08-26'), '');
  assert.strictEqual(jn.formatJournalContext({ '2026-08-24': {} }, '2026-08-26'), '');
});

test('formatJournalContext: a note with only free text still renders', () => {
  const out = jn.formatJournalContext({ '2026-08-24': { text: 'chased the open' } }, '2026-08-26');
  assert.ok(out.includes('chased the open'), out);
  assert.ok(!/lesson/i.test(out.split('Recent journal')[0]), 'no lesson heading when there is no lesson');
});

test('recentNotes: newest first, capped, blanks skipped', () => {
  const notes = {
    '2026-08-20': { lesson: 'a' }, '2026-08-21': { lesson: 'b' },
    '2026-08-22': {}, '2026-08-24': { lesson: 'd' },
  };
  const rows = jn.recentNotes(notes, '2026-08-26', 2);
  assert.deepStrictEqual(rows.map(r => r.date), ['2026-08-24', '2026-08-21']);
});

test('recentNotes: ignores keys that are not dates', () => {
  const rows = jn.recentNotes({ 'notes': { lesson: 'x' }, '2026-08-24': { lesson: 'y' } }, '2026-08-26', 5);
  assert.deepStrictEqual(rows.map(r => r.date), ['2026-08-24']);
});

test('repeatedMistake: two occurrences is a pattern', () => {
  const notes = {
    '2026-08-21': { mistake: 'oversized' },
    '2026-08-22': { mistake: 'held loser' },
    '2026-08-24': { mistake: 'oversized' },
  };
  const r = jn.repeatedMistake(notes, '2026-08-26', 7);
  assert.strictEqual(r.mistake, 'oversized');
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.of, 3);
});

test('repeatedMistake: ONE occurrence is not a pattern', () => {
  // Presenting a single bad day as a trend is how a coaching line stops
  // being believed — this must stay null, not a one-count "pattern".
  assert.strictEqual(jn.repeatedMistake(REAL, '2026-08-26', 7), null);
});

test('repeatedMistake: the em-dash placeholder is not a mistake', () => {
  const notes = { '2026-08-21': { mistake: '—' }, '2026-08-22': { mistake: '—' } };
  assert.strictEqual(jn.repeatedMistake(notes, '2026-08-26', 7), null);
});

test('formatJournalContext: names a repeat explicitly when one exists', () => {
  const notes = {
    '2026-08-21': { mistake: 'oversized', lesson: 'size down' },
    '2026-08-24': { mistake: 'oversized', lesson: 'size down' },
  };
  const out = jn.formatJournalContext(notes, '2026-08-26');
  assert.ok(/REPEATED: he has named "oversized"[\s\S]*2 of the last 2/.test(out), out);
});

test('clip: long free text is truncated, never paraphrased away', () => {
  const long = 'x'.repeat(400);
  const out = jn.formatJournalContext({ '2026-08-24': { text: long } }, '2026-08-26');
  assert.ok(out.includes('…'), 'must mark the truncation');
  assert.ok(out.length < 700, 'must not blow the context budget: ' + out.length);
  assert.ok(out.includes('xxxx'), 'the surviving prefix must be his actual text');
});

test('clip: newlines in his note cannot break the context block structure', () => {
  const out = jn.formatJournalContext(
    { '2026-08-24': { text: 'line one\n### FAKE HEADING\nline two' } }, '2026-08-26');
  // The protection is that whitespace collapses to single spaces, so nothing
  // he types can START a line. The text itself stays intact inside the quotes
  // — censoring his own words would be the worse failure.
  assert.ok(!/^[ \t]*###/m.test(out), 'no line may begin with a forged heading');
  assert.ok(out.includes('line one ### FAKE HEADING line two'), 'his words stay verbatim');
});

test('"partly" is reported as partly — the dropdown has three answers, not two', () => {
  // Caught on his REAL 2026-08-24 note. Collapsing partly into "did NOT
  // follow his plan" puts a word in his mouth he did not select.
  const out = jn.formatJournalContext({ '2026-08-24': { followedPlan: 'partly' } }, '2026-08-26');
  assert.ok(out.includes('followed his plan partly'), out);
  assert.ok(!out.includes('did NOT'), out);
});

test('a clean day ("none") is never counted as a repeated mistake', () => {
  // "none" is a real dropdown option meaning he judged the day clean. Counting
  // it would surface a run of GOOD days as a pattern to fix.
  const notes = { '2026-08-21': { mistake: 'none' }, '2026-08-24': { mistake: 'none' } };
  assert.strictEqual(jn.repeatedMistake(notes, '2026-08-26', 7), null);
});

// ── Stick-rate scorecard (2026-08-25) ───────────────────────────────────────
// "a lesson you keep re-learning looks identical to one you fixed."

const HIST = {
  '2026-08-17': { followedPlan: 'no', mistake: 'oversized', lesson: 'start small tomorrow' },
  '2026-08-18': { followedPlan: 'yes', mistake: 'none', lesson: 'wait for the retest' },
  '2026-08-19': { followedPlan: 'no', mistake: 'oversized', lesson: 'I should start small for tomorrow' },
  '2026-08-20': { followedPlan: 'partly', mistake: 'revenge re-entry', lesson: 'stop after two losses' },
  '2026-08-21': { followedPlan: 'yes', mistake: 'none', lesson: 'trust the 4H bias' },
  '2026-08-24': { followedPlan: 'partly', mistake: 'oversized', lesson: 'start small for tomorrow, size up later' },
};

test('clusterLessons: the same lesson phrased three ways is ONE repeat', () => {
  const g = jn.clusterLessons(HIST, '2026-08-26');
  const top = g[0];
  assert.strictEqual(top.count, 3);
  assert.deepStrictEqual(top.items.map(i => i.date), ['2026-08-24', '2026-08-19', '2026-08-17']);
});

test('clusterLessons: keeps every matched line VERBATIM so a bad match is visible', () => {
  const top = jn.clusterLessons(HIST, '2026-08-26')[0];
  assert.ok(top.items.some(i => i.text === 'start small tomorrow'));
  assert.ok(top.items.some(i => i.text === 'I should start small for tomorrow'));
});

test('clusterLessons: genuinely different lessons are NOT merged', () => {
  const g = jn.clusterLessons(HIST, '2026-08-26');
  const texts = g.filter(x => x.count === 1).map(x => x.items[0].text);
  assert.ok(texts.includes('wait for the retest'), JSON.stringify(texts));
  assert.ok(texts.includes('trust the 4H bias'), JSON.stringify(texts));
});

test('lessonSimilarity: one shared common word is not a repeat', () => {
  assert.ok(jn.lessonSimilarity('size down after a loss', 'trade the London session') < jn.LESSON_MATCH);
});

test('lessonTokens: stopwords and punctuation carry no identity', () => {
  assert.deepStrictEqual(jn.lessonTokens('I should start small for tomorrow!'), ['start', 'small']);
});

test('planAdherence: counts yes/partly/no and never collapses partly into no', () => {
  const a = jn.planAdherence(HIST, '2026-08-26');
  assert.strictEqual(a.total, 6);
  assert.strictEqual(a.yes, 2);
  assert.strictEqual(a.partly, 2);
  assert.strictEqual(a.no, 2);
  assert.strictEqual(a.pct, 33);
});

test('planAdherence: a trend needs a real sample on BOTH sides', () => {
  // 6 days with recent=5 leaves ONE earlier day. Calling 40% vs a single 0%
  // day "improving" is noise presented as progress.
  assert.strictEqual(jn.planAdherence(HIST, '2026-08-26').trend, null);
  const more = Object.assign({
    '2026-08-14': { followedPlan: 'no' }, '2026-08-15': { followedPlan: 'no' },
  }, HIST);
  assert.strictEqual(jn.planAdherence(more, '2026-08-26').trend, 'improving');
});

test('planAdherence: null when the field was never filled in', () => {
  assert.strictEqual(jn.planAdherence({ '2026-08-24': { lesson: 'x' } }, '2026-08-26'), null);
});

test('mistakeRecurrence: counts returns AFTER it was first named', () => {
  const m = jn.mistakeRecurrence(HIST, '2026-08-26').find(x => x.mistake === 'oversized');
  assert.strictEqual(m.count, 3);
  assert.strictEqual(m.recurred, 2);
  assert.strictEqual(m.first, '2026-08-17');
  // Denominator is JOURNALLED days after that date, not calendar days — a day
  // he did not write up must not be silently counted as clean.
  assert.strictEqual(m.sinceDays, 5);
});

test('mistakeRecurrence: "none" and the em-dash placeholder are not mistakes', () => {
  const list = jn.mistakeRecurrence(HIST, '2026-08-26').map(x => x.mistake);
  assert.ok(!list.includes('none'));
  assert.ok(!list.includes('—'));
});

test('buildScorecard: headline is the most-repeated lesson', () => {
  const sc = jn.buildScorecard(HIST, '2026-08-26');
  assert.strictEqual(sc.journalledDays, 6);
  assert.strictEqual(sc.headline.count, 3);
  assert.strictEqual(sc.repeatedMistakes[0].mistake, 'oversized');
});

test('buildScorecard: only REPEATS are reported, never a one-off as a pattern', () => {
  const once = { '2026-08-24': { mistake: 'oversized', lesson: 'start small', followedPlan: 'no' } };
  const sc = jn.buildScorecard(once, '2026-08-26');
  assert.strictEqual(sc.headline, null);
  assert.deepStrictEqual(sc.repeatedLessons, []);
  assert.deepStrictEqual(sc.repeatedMistakes, []);
});

test('buildScorecard: null on an empty journal, never an all-clear', () => {
  assert.strictEqual(jn.buildScorecard({}, '2026-08-26'), null);
  assert.strictEqual(jn.buildScorecard(null, '2026-08-26'), null);
});

test('buildScorecard: today is excluded — the panel reports finished days', () => {
  assert.strictEqual(jn.buildScorecard(HIST, '2026-08-17'), null);
});

test('formatScorecardContext: gives Jessi the count and the exact sentences', () => {
  const out = jn.formatScorecardContext(HIST, '2026-08-26');
  assert.ok(/written this same lesson 3 times/.test(out), out);
  assert.ok(out.includes('"start small tomorrow"'), out);
  assert.ok(/Writing it again is not the fix/.test(out), out);
  assert.ok(/"oversized" first named 2026-08-17, back 2 more times/.test(out), out);
});

test('formatScorecardContext: empty when there is nothing to report', () => {
  assert.strictEqual(jn.formatScorecardContext({}, '2026-08-26'), '');
});

test('scorecard: UMD — the renderer and server get the same object', () => {
  // The Journal panel and Jessi must quote the same numbers about the same
  // days; two copies of this maths would drift into contradicting each other.
  const src = fs.readFileSync(path.join(__dirname, '..', 'journal-notes.js'), 'utf8');
  assert.ok(/window\.JournalNotes = EXPORTS/.test(src), 'must expose window.JournalNotes');
  assert.ok(/module\.exports = EXPORTS/.test(src), 'must still export for Node');
});
