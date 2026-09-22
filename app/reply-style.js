'use strict';
/* ── reply-style.js — the OUTPUT CONTRACT for chat, and a way to measure it ──
 *
 * (2026-09-21. Anoop: "give me a route to give better more simple and less
 * complicated output on chat which are not very long and unreadable.")
 *
 * ── THE DIAGNOSIS, WHICH IS NARROWER THAN IT LOOKS ─────────────────────────
 * The VOICE persona already says:
 *
 *   "CRITICAL: this is VOICE — keep every reply to 1-3 short spoken sentences.
 *    No lists, no markdown, no long explanations."
 *
 * No TEXT surface says anything. Grepping the shared rules and every text
 * persona for a length constraint returns nothing. So the voice surface was
 * fixed once and the text surfaces never were, and a model given no length
 * instruction fills whatever space it is given — with preamble, with the
 * question restated back to him, with headings and bullets and three hedged
 * options where he wanted one answer.
 *
 * That is why this is a prompt fix and not a UI fix: the length problem is
 * caused by an absent instruction, not by the surface rendering it.
 *
 * ── WHY THE CONTRACT IS ONE CONSTANT ───────────────────────────────────────
 * Same reason the doctrine and the math are: several personas need it, and two
 * copies of a rule drift. It is appended in one place per surface, and the text
 * below is the ONLY copy.
 *
 * ── WHY THERE IS AN AUDIT BESIDE IT ────────────────────────────────────────
 * "Is it better now" must not be a feeling. The audit reads the REAL replies out
 * of the chat archive and reports the distribution — median lines, share over
 * budget, the commonest opener — so a prompt change can be judged against the
 * days before it. This is the same discipline as every other measured thing in
 * this repo, applied to the one surface that had no measurement at all.
 *
 * PURE. The contract is a string; the audit takes text and returns numbers.
 */

// ── THE CONTRACT ───────────────────────────────────────────────────────────
// REWRITTEN 2026-09-21 from his own archive, not from theory. The three longest
// replies on record (25, 22 and 21 lines; 497, 429 and 441 words) were audited
// line by line, and the bloat was not padding — it was two specific habits:
//
//   1. RE-TEACHING HIM HIS OWN PLAYBOOK. Every one of them explained, in full,
//      "For a bullish FVG you buy after price pulls down into the gap" — to the
//      man who wrote that rule. All three also restated that the day is NO-GO,
//      which the HUD says. That single habit is worth several sentences a reply.
//   2. SAYING EACH NUMBER TWICE. "The zone moved. 30124.00-30126.00. ... But the
//      gap is 2.00 points wide. 30124.00-30126.00."
//
// So the fix is a 5-6 SENTENCE budget WITH A REQUIRED SHAPE, because a bare
// count invites filler to reach it. The shape names what the sentences are FOR,
// and "never pad to reach six" is stated explicitly: the count is a ceiling,
// not a quota. Worked before/after examples are in CHAT_STYLE_EXAMPLES.md.
const OUTPUT_CONTRACT = [
'',
'## HOW YOU WRITE — every reply, on every surface',
'He reads this on a phone, usually with a position open. Long is not thorough, it is unread.',
'',
'- 5-6 SENTENCES MAXIMUM. Not 5-6 paragraphs and not 5-6 numbered points. A sentence ends in a full stop.',
'- USE THIS SHAPE, in order: (1) the answer, (2) the number it turns on, (3) why, (4) what would',
'  invalidate it, (5) what to do. A sixth sentence only if there is a caveat he does not already know.',
'- NEVER PAD TO REACH SIX. Three good sentences beat six with filler: the count is a ceiling, not a quota.',
'- NO PREAMBLE. Never open with "Let me pull live state", "I have it", "Great question", "Sure", or',
'  "NO ACTION — but ...". Start with the answer itself.',
'- DO NOT EXPLAIN HIS OWN PLAYBOOK BACK TO HIM. He wrote it. Never restate how an FVG, an engulf or an',
'  SFP works, where his marked levels are, what his written rules say, or that his day is NO-GO.',
'- SAY EACH NUMBER ONCE. Not twice in one paragraph, and not again in the next one.',
'- NEVER RESTATE his question, and never repeat the same conclusion in different words.',
'- No headings, no numbered points, no bullets, unless he asks for a breakdown.',
'- ONE recommendation, not three options. Offer alternatives only if he asks.',
'- NUMBERS IN ONE FORMAT: $1,234.50 · 29,960.25 · 4 contracts · 2R',
'- NAME A RULE ONCE when it applies. Do not lecture him about a rule he wrote.',
'- If the honest answer truly needs more, give the 5-6 sentences and end with: "say more for the detail."',
'- Never pad with risk disclaimers. He knows the risk.',
].join('\n');

// The compact variant for surfaces that already constrain themselves (voice
// already enforces 1-3 spoken sentences). Adding the full block there would be
// two length rules arguing, which is worse than either alone.
const OUTPUT_CONTRACT_SHORT = [
'',
'## HOW YOU WRITE',
'One short spoken answer. No preamble, no restating his question, no playbook explanations, one recommendation.',
'Numbers as $1,234.50 · 29,960.25 · 4 contracts · 2R.',
].join('\n');

const DEFAULTS = Object.freeze({
  // The contract is written in SENTENCES, so the audit is too. Lines are still
  // reported because he reads them on a phone, but they are not the budget —
  // measuring lines would have called a 6-sentence answer "over budget" purely
  // because it wrapped.
  maxSentences: 6,
  hardMaxSentences: 14,   // past this it is not a long answer, it is an essay
  maxLines: 10,           // secondary, reported not enforced
  hardMaxLines: 22,
});

const PREAMBLE = /^\s*(great question|good question|sure[,!]|of course|certainly|absolutely|let me|i can see|i understand|thanks for|that'?s a (great|good)|here'?s (what|a|the)|okay so|alright)/i;

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function round2(n) { return Math.round(n * 100) / 100; }

/** Split a reply into the lines he actually sees (blank lines are not lines). */
function lines(text) {
  return String(text == null ? '' : text).split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Sentences, crudely but usefully: terminal punctuation followed by space/end. */
function sentences(text) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!t) return 0;
  return t.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length).length;
}

/**
 * Score ONE reply against the contract.
 *
 * The verdict is deliberately coarse. A fine-grained score would invite tuning
 * the score instead of the replies.
 */
function auditReply(text, opts) {
  const cfg = Object.assign({}, DEFAULTS, opts || {});
  const raw = String(text == null ? '' : text);
  const ls = lines(raw);
  const nLines = ls.length;
  const nSent = sentences(raw);
  const chars = raw.trim().length;
  const first = ls.length ? ls[0] : '';
  const hasPreamble = PREAMBLE.test(first);
  const bullets = ls.filter((l) => /^([-*•]|\d+[.)])\s/.test(l)).length;
  const headings = ls.filter((l) => /^#{1,6}\s/.test(l)).length;
  // The habit that cost the most words in the real archive: explaining his own
  // strategy, levels or rules back to him. Detected with a short list of
  // high-signal phrases and reported as a COUNT, never as a verdict — a heuristic
  // that decides pass/fail would be wrong often enough to be ignored.
  const teachesBack = /for a (bullish|bearish) (fvg|engulf|sfp)|you correctly|your rule says|remember that|as you know|the playbook requires|your marked levels/i.test(raw);
  const verdict = nSent === 0 && nLines === 0 ? 'EMPTY'
    : (nSent <= cfg.maxSentences && !hasPreamble) ? 'TIGHT'
    : nSent > cfg.hardMaxSentences ? 'ESSAY'
    : 'LONG';
  return {
    lines: nLines, sentences: nSent, words: raw.split(/\s+/).filter(Boolean).length,
    chars, hasPreamble, bullets, headings, teachesBack, verdict,
    overBudget: nSent > cfg.maxSentences,
    overLongLines: nLines > cfg.maxLines,
  };
}

/**
 * Score a WHOLE set of replies (typically one surface over one day).
 *
 * Reports the median and the share over budget rather than an average, because
 * one long verdict drags a mean and tells you nothing about the common case.
 */
function auditReplies(rows, opts) {
  const cfg = Object.assign({}, DEFAULTS, opts || {});
  // ── ONLY MODEL OUTPUT IS AUDITED (2026-09-21) ───────────────────────────
  // The chat archive captures EVERYTHING that appears in the pane — that is its
  // purpose — so it also holds the app's own notices: shadow tickets, armed-setup
  // cards, PO3 phase changes, guardrail alarms. Those are not replies, and the
  // first version of this counted them: a 3-line PO3 notice was scored TIGHT and
  // briefly looked like evidence the style fix had worked, when in fact no model
  // reply had happened at all.
  //
  // The marker list is the app's own vocabulary, so it stays cheap and exact.
  // A row that carries an explicit non-assistant role is excluded too.
  const audited = (Array.isArray(rows) ? rows : [])
    .filter((r) => {
      if (typeof r === 'string') return true;
      if (!r) return false;
      const role = String(r.role || '');
      if (role && role !== 'assistant') return false;
      const t = String(r.text || r.content || r.message || '');
      if (/^[\u25B1\u25B8\u25CF\u2022\u2705\u26A0\u{1F514}\u{1F4E1}\u{1F4CB}\u{1F4B0}\u{1F525}]/u.test(t)) return false;  // app notices
      if (/^(SETUP ARMED|SHADOW TICKET|POWER OF 3|Engulf signal|FVG on|Playbook B confirmed|LIVE FEED PROTOCOL|BAR RECORD GAP|TRADE TICKET|Size guard|NO-TRADE)/i.test(t)) return false;
      return true;
    })
    .map((r) => auditReply(typeof r === 'string' ? r : (r && (r.text || r.content || r.message)) || '', cfg))
    .filter((a) => a.verdict !== 'EMPTY');
  if (!audited.length) {
    return { n: 0, medianSentences: null, overBudgetPct: null, preambles: 0, verdict: 'NO_DATA', summary: 'No replies to audit yet.' };
  }
  const sortedS = audited.map((a) => a.sentences).sort((a, b) => a - b);
  const sortedL = audited.map((a) => a.lines).sort((a, b) => a - b);
  const median = sortedS[Math.floor(sortedS.length / 2)];
  const medianLines = sortedL[Math.floor(sortedL.length / 2)];
  const over = audited.filter((a) => a.overBudget).length;
  const preambles = audited.filter((a) => a.hasPreamble).length;
  const essays = audited.filter((a) => a.verdict === 'ESSAY').length;
  const teaches = audited.filter((a) => a.teachesBack).length;
  const pct = Math.round((over / audited.length) * 100);
  const verdict = pct <= 20 ? 'TIGHT' : pct <= 45 ? 'LONG' : 'BLOATED';
  return {
    n: audited.length, medianSentences: median, medianLines,
    meanSentences: round2(audited.reduce((a, b) => a + b.sentences, 0) / audited.length),
    maxSentences: sortedS[sortedS.length - 1],
    overBudgetPct: pct, preambles, essays, teachesBack: teaches,
    withBullets: audited.filter((a) => a.bullets > 0).length,
    withHeadings: audited.filter((a) => a.headings > 0).length,
    verdict, maxSentencesBudget: cfg.maxSentences,
    summary: audited.length + ' replies: median ' + median + ' sentence(s) (' + medianLines + ' lines), '
      + pct + '% over the ' + cfg.maxSentences + '-sentence budget, ' + preambles + ' opened with a preamble, '
      + teaches + ' re-explained his own playbook, ' + essays + ' over ' + cfg.hardMaxSentences + ' sentences.',
  };
}


/**
 * The style reminder, for the END of the user turn.
 *
 * ── WHY THE SYSTEM-PROMPT CONTRACT IS NOT ENOUGH (measured 2026-09-21) ──────
 * The contract was appended to the system prompt and the very first reply after
 * the restart still came out at 31 sentences with four numbered points. The
 * contract was present — this is not a wiring bug. It was OUT-COMPETED.
 *
 * handleChat sends the WHOLE conversation (buildContextMessage + state.messages),
 * and that history is full of the model's own earlier answers: 25-line, 64-
 * sentence numbered briefings, in its own voice. Against a dozen in-context
 * examples, one instruction block at the end of an already long system prompt
 * loses. The model was imitating itself, which is exactly what few-shot context
 * is FOR — so the same mechanism is used here, deliberately, on the side we want.
 *
 * Instructions adjacent to the point of generation are followed far more
 * reliably than ones buried above a long prompt. This repeats the rule there,
 * in the cheapest possible form, without adding a turn to the conversation.
 */
function withStyleReminder(messages, opts) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  if (!list.length) return list;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || m.role !== 'user' || typeof m.content !== 'string') continue;
    // Idempotent: a retry or a re-send must not stack the reminder.
    if (/\[STYLE:/.test(m.content)) return list;
    list[i] = Object.assign({}, m, { content: m.content + '\n\n' + STYLE_REMINDER });
    return list;
  }
  return list;
}

// Deliberately terse. It is repeated every turn, so it costs tokens on every
// call and must earn them — the full reasoning lives in the contract above.
const STYLE_REMINDER = '[STYLE: 5-6 sentences maximum. No preamble, no numbered points or bullets, do not restate '
  + 'the question, and do not explain his own playbook, levels or rules back to him. Shape: answer, the number, '
  + 'why, what invalidates it, what to do.]';

module.exports = {
  OUTPUT_CONTRACT, OUTPUT_CONTRACT_SHORT, STYLE_REMINDER, DEFAULTS,
  lines, sentences, auditReply, auditReplies, withStyleReminder,
};
