// ── Verdict grounding check (2026-08-16, Pattern 05: Evaluator-optimizer) ───
// Anthropic's "Building Effective Agents": an evaluator-optimizer pair fits
// when there are clear evaluation criteria and refinement provides measurable
// value. Whether a dollar figure the Judge just wrote actually appears in the
// data it was handed is about as clear a criterion as exists — and cheap
// enough to check with plain string/number matching, no second LLM call.
//
// WHY THIS EXISTS — the incident it is a runtime backstop for
// On 2026-08-10, in this exact Debate flow, Jessi produced a 5-row trade
// table (-312/-245/-180/-95/-47) that exists nowhere in Anoop's history,
// while the Analysis agent — same question, same moment — reported the real
// trades correctly. The root cause (see the 2026-08-11 note above
// handleDebateChat) was structural: Jessi had no tools and no real data
// context, so asked for a data-dense argument, she invented one.
//
// That specific hole was closed by SEEDING Jessi with real data
// (jessiDataContext) plus an explicit "you must not invent" instruction.
// JUDGE_PERSONA separately carries a "DATA-INTEGRITY HALT" instruction
// (#6) telling the Judge itself to catch cross-agent numeric mismatches.
// Both fixes are PROMPT TEXT — an instruction, not a check. Nothing verifies
// either was actually followed on a given call. This module is that check,
// applied at the one place all three parallel arguments funnel through: the
// Judge's final synthesized verdict.
//
// WHAT IT DOES NOT DO
// It does not re-run the Judge, and it does not silently drop or edit the
// verdict — this app's established pattern (see checklist-logic.js's
// ckGateOpen, journey-tracker.js's transition guards) is FAIL VISIBLE, never
// fail silent and never fail closed on something that would strand Anoop
// mid-session. An ungrounded figure gets a clearly-marked warning appended,
// not a block. False positives are expected and tolerated for one specific,
// legitimate reason: the Judge may correctly cite a static rule threshold
// (e.g. "$200 hard stop") that happens not to have been repeated verbatim by
// any of the three 45-word-capped arguments. knownAmountsFromRules() closes
// most of that gap by treating every numeric value in the live rules.json
// (via getActiveRules()) as pre-grounded — those are real config values, not
// invented data, and the Judge is entitled to cite them from persona
// knowledge without a sub-agent having said them first.

// Matches "$1,234.56", "$150", "-$50", "-$1,234" — the exact shape
// costMoney()/journeyMoney() in the renderer already produce, so verdict text
// that echoes an app-rendered figure matches byte-for-byte. Commas are
// required to fall in real thousands-separator groups of exactly three
// digits (not `[\d,]+`, which greedily swallowed the LIST-separating comma
// after a figure in prose like "-$180, -$245, -$312" and produced
// "-$180," as one bogus token — caught by the 08-10 replay test).
const DOLLAR_RE = /-?\$\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?/g;

function parseDollarAmount(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/\s/g, '');
  const neg = s.trim().startsWith('-');
  const digits = s.replace(/[-$,]/g, '');
  if (!digits) return null;
  const n = parseFloat(digits);
  if (!isFinite(n)) return null;
  return neg ? -n : n;
}

function extractDollarAmounts(text) {
  if (!text || typeof text !== 'string') return [];
  const matches = text.match(DOLLAR_RE) || [];
  return matches
    .map(raw => ({ raw: raw.trim(), value: parseDollarAmount(raw) }))
    .filter(m => m.value != null);
}

// Flattens every finite number out of a rules object (and its own sign
// inverse, since dailyLossTiers/perTradeMaxLoss are stored positive but
// almost always cited as a loss, e.g. "-$200") into a Set of legitimate,
// non-fabricated values.
function knownAmountsFromRules(rules) {
  const out = new Set();
  (function walk(v) {
    if (v == null) return;
    if (typeof v === 'number' && isFinite(v)) { out.add(v); out.add(-v); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') { Object.keys(v).forEach(k => walk(v[k])); }
  })(rules);
  return out;
}

/**
 * @param {string} verdictText   the Judge's final synthesized output
 * @param {string} sourceText    everything the Judge was actually handed
 *                                (the three arguments + bias block — NOT the
 *                                Judge's own persona instructions, which
 *                                carry no dollar figures of their own)
 * @param {object} [rules]       getActiveRules() output, for the static-
 *                                threshold allowance described above
 * @returns {{ok: boolean, ungrounded: string[]}}
 */
function checkGrounding(verdictText, sourceText, rules) {
  const cited = extractDollarAmounts(verdictText);
  if (!cited.length) return { ok: true, ungrounded: [] };
  const known = knownAmountsFromRules(rules || {});
  const sourceAmounts = extractDollarAmounts(sourceText || '');
  const ungrounded = cited.filter(c => {
    if (sourceText && sourceText.indexOf(c.raw) !== -1) return false; // exact string match
    if (known.has(c.value)) return false;                              // legitimate static rule
    if (sourceAmounts.some(s => s.value === c.value)) return false;    // same value, different formatting
    return true;
  });
  return { ok: ungrounded.length === 0, ungrounded: ungrounded.map(u => u.raw) };
}

// One clearly-marked block, appended (never silently substituted) to a
// verdict that failed the check. Deliberately says "may be" rather than
// asserting fabrication — the false-positive case (a correctly-cited static
// rule threshold not caught by knownAmountsFromRules) is real and the wording
// must not read as an accusation on an otherwise-correct verdict.
function groundingWarningBlock(ungrounded) {
  if (!ungrounded || !ungrounded.length) return '';
  const list = ungrounded.join(', ');
  return `\n\n---\n⚠ **DATA CHECK:** ${list} — this figure does not appear in the data the three agents were given, and isn't a known rule threshold. It may be a real rule reference stated from memory, or it may be invented. Verify against your own records before acting on it.`;
}

module.exports = { extractDollarAmounts, parseDollarAmount, knownAmountsFromRules, checkGrounding, groundingWarningBlock };
