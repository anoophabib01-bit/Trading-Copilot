'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const rs = require('../reply-style');

// ── the contract itself ────────────────────────────────────────────────────
test('the contract is short enough to be read — a long brevity rule is ignored', () => {
  const n = rs.OUTPUT_CONTRACT.split('\n').filter((l) => l.trim()).length;
  assert.ok(n <= 24, 'the contract is ' + n + ' lines; it must practise what it preaches');
});

test('the contract states the budget, the shape, and the two habits the archive proved', () => {
  assert.match(rs.OUTPUT_CONTRACT, /5-6 SENTENCES MAXIMUM/);
  assert.match(rs.OUTPUT_CONTRACT, /USE THIS SHAPE/);
  // Both of these came from auditing the real archive, not from theory.
  assert.match(rs.OUTPUT_CONTRACT, /DO NOT EXPLAIN HIS OWN PLAYBOOK BACK TO HIM/);
  assert.match(rs.OUTPUT_CONTRACT, /SAY EACH NUMBER ONCE/);
});

test('the count is a CEILING, not a quota — stated, because a bare number invites filler', () => {
  assert.match(rs.OUTPUT_CONTRACT, /NEVER PAD TO REACH SIX/);
});

test('it names the escape hatch, so a genuinely long answer still has a shape', () => {
  assert.match(rs.OUTPUT_CONTRACT, /say more for the detail/);
});

test('there is a SHORT variant for surfaces that already constrain themselves', () => {
  // Voice already says 1-3 sentences; two length rules arguing is worse than one.
  assert.ok(rs.OUTPUT_CONTRACT_SHORT.length < rs.OUTPUT_CONTRACT.length);
  assert.match(rs.OUTPUT_CONTRACT_SHORT, /No preamble/);
});

// ── auditing one reply ─────────────────────────────────────────────────────
test('a five-sentence answer with no preamble is TIGHT', () => {
  const a = rs.auditReply('Wait on this one. MSFT is 350 points below the zone, so there is no retrace to buy. A bullish FVG needs price to pull back into the gap first. It invalidates if price closes above 30,126 without touching it. Do nothing until NY opens.');
  assert.equal(a.verdict, 'TIGHT');
  assert.ok(a.sentences <= 6);
  assert.equal(a.overBudget, false);
});

test('a preamble in the FIRST line is caught, whoever wrote it', () => {
  for (const opener of ['Great question! Here is the answer.', 'Let me check that for you.', 'Sure, absolutely.',
                        'I can see why you would ask.', 'Okay so the thing is this.']) {
    assert.equal(rs.auditReply(opener).hasPreamble, true, '"' + opener + '" must read as a preamble');
  }
});

test('a preamble on a LATER line is not a preamble — the rule is about openings', () => {
  const a = rs.auditReply('Wait.\nGreat question, but the answer is still wait.');
  assert.equal(a.hasPreamble, false);
});

test('the budget is SENTENCES, so a wrapped answer is not punished for wrapping', () => {
  // Six sentences across ten short lines is the same answer as six across three.
  const wrapped = Array.from({ length: 6 }, (_, i) => 'Sentence number ' + i + ' says something short.').join('\n');
  const runOn = 'Sentence one says something short. Sentence two says something short. Sentence three says something short. Sentence four says something short. Sentence five says something short. Sentence six says something short.';
  assert.equal(rs.auditReply(wrapped).verdict, 'TIGHT');
  assert.equal(rs.auditReply(runOn).verdict, 'TIGHT');
  assert.equal(rs.auditReply(wrapped).overBudget, false);
});

test('past the hard ceiling a reply is an ESSAY, not merely long', () => {
  const long = Array.from({ length: 20 }, (_, i) => 'This is sentence number ' + i + ' of an essay.').join(' ');
  assert.equal(rs.auditReply(long).verdict, 'ESSAY');
});

test('blank lines are not lines — a padded answer is not a long one', () => {
  const a = rs.auditReply('One.\n\n\nTwo.\n\nThree.');
  assert.equal(a.lines, 3);
  assert.equal(a.verdict, 'TIGHT');
});

test('bullets and headings are counted, because the contract forbids them by default', () => {
  const a = rs.auditReply('## Headline\n- one\n- two\n3. three');
  assert.equal(a.headings, 1);
  assert.equal(a.bullets, 3);
});

test('re-explaining his own playbook is detected — the habit that cost the most words', () => {
  // Verbatim from the real archive: the longest reply explained FVG mechanics to
  // the man who wrote the rule.
  const a = rs.auditReply('No action. For a bullish FVG you buy after price pulls down into the gap. Price is below it.');
  assert.equal(a.teachesBack, true);
  assert.equal(rs.auditReply('No action. Price is 164 points below the zone, so there is nothing to buy.').teachesBack, false);
});

test('an empty reply is EMPTY, not TIGHT — they are different problems', () => {
  assert.equal(rs.auditReply('').verdict, 'EMPTY');
  assert.equal(rs.auditReply(null).verdict, 'EMPTY');
  assert.equal(rs.auditReply('   \n  ').verdict, 'EMPTY');
});

test('auditReply never throws on junk', () => {
  for (const bad of [null, undefined, 42, {}, []]) assert.doesNotThrow(() => rs.auditReply(bad));
});

// ── auditing a set ─────────────────────────────────────────────────────────
// n SENTENCES, because the budget is sentences. A bare list of lines with no
// punctuation is ONE sentence, which is exactly the mistake these fixtures made.
const reply = (n) => Array.from({ length: n }, (_, i) => 'This is sentence number ' + i + '.').join(' ');

test('the median is reported, not the mean, because one verdict drags an average', () => {
  const rows = [reply(1), reply(2), reply(3), reply(30)];
  const a = rs.auditReplies(rows);
  assert.equal(a.medianSentences, 3, 'the median must ignore the one enormous reply');
  assert.ok(a.meanSentences > a.medianSentences, 'the mean is dragged by the 30-sentence reply; the median is not');
});

test('the share over budget is what the verdict turns on', () => {
  const tight = rs.auditReplies([reply(1), reply(2), reply(2), reply(3), reply(3)]);
  assert.equal(tight.overBudgetPct, 0);
  assert.equal(tight.verdict, 'TIGHT');
  const bloated = rs.auditReplies(Array.from({ length: 10 }, () => reply(8)));
  assert.equal(bloated.overBudgetPct, 100);
  assert.equal(bloated.verdict, 'BLOATED');
});

test('preambles and essays are counted separately from length', () => {
  const a = rs.auditReplies(['Great question! Wait.', 'Wait.', reply(20)]);
  assert.equal(a.n, 3);
  assert.equal(a.preambles, 1);
  assert.equal(a.essays, 1, 'over the hard ceiling is an ESSAY, not merely long');
});

test('empty replies are excluded from the distribution rather than counted as zero', () => {
  const a = rs.auditReplies(['', null, 'Wait.']);
  assert.equal(a.n, 1, 'only the real reply counts');
});

test('no data says so rather than reporting a flattering zero', () => {
  const a = rs.auditReplies([]);
  assert.equal(a.verdict, 'NO_DATA');
  assert.equal(a.medianSentences, null);
  assert.equal(a.overBudgetPct, null);
});

test('it accepts archive rows as well as bare strings', () => {
  const a = rs.auditReplies([{ role: 'assistant', text: 'Wait.' }, { text: 'Wait.' }, 'Wait.']);
  assert.equal(a.n, 3);
});

test('the summary never claims a quality score — only what was measured', () => {
  const a = rs.auditReplies([reply(1), reply(20)]);
  assert.match(a.summary, /median/);
  assert.equal(/good|bad|quality|score/i.test(a.summary), false);
});
// ── the style reminder at the generation point (2026-09-21) ─────────────────
test('the reminder lands on the LAST user turn — the point of generation', () => {
  const m = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }];
  const out = rs.withStyleReminder(m);
  assert.ok(out[2].content.includes('[STYLE:'));
  assert.equal(out[0].content, 'a', 'earlier turns are untouched');
  assert.equal(out[2].content.startsWith('c'), true, 'the original content is preserved, not replaced');
});

test('it is idempotent — a retry must not stack the reminder', () => {
  const once = rs.withStyleReminder([{ role: 'user', content: 'c' }]);
  const twice = rs.withStyleReminder(once);
  assert.equal(twice[0].content.split('[STYLE:').length, 2);
});

test('the input array and its messages are not mutated', () => {
  const m = [{ role: 'user', content: 'c' }];
  rs.withStyleReminder(m);
  assert.equal(m[0].content, 'c');
});

test('the reminder repeats the rules the archive proved were being broken', () => {
  assert.match(rs.STYLE_REMINDER, /5-6 sentences/);
  assert.match(rs.STYLE_REMINDER, /numbered points/);
  assert.match(rs.STYLE_REMINDER, /do not explain his own playbook/);
  assert.match(rs.STYLE_REMINDER, /what invalidates it/);
});

test('the reminder is terse — it is paid for on every single call', () => {
  assert.ok(rs.STYLE_REMINDER.length < 400, 'reminder is ' + rs.STYLE_REMINDER.length + ' chars');
});

test('no user turn, or junk, returns the messages unchanged rather than throwing', () => {
  for (const bad of [[], null, undefined, 'x', [{ role: 'assistant', content: 'b' }]]) {
    assert.doesNotThrow(() => rs.withStyleReminder(bad));
  }
  assert.deepEqual(rs.withStyleReminder([{ role: 'assistant', content: 'b' }]), [{ role: 'assistant', content: 'b' }]);
});
