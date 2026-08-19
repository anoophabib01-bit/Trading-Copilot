// ── Assistive routing (2026-08-16, Pattern 02) ───────────────────────────────
// Anthropic's "Building Effective Agents": routing "classifies an input and
// directs it to a specialized followup task... works well where classification
// can be handled accurately."
//
// WHY THIS IS ADVISORY, NOT ACTUAL ROUTING
// Full auto-routing on a live trading chat is riskier than it is worth — a
// misclassification mid-session (silently answering with the wrong
// specialist's rules while real money is on) is worse than today's baseline
// of "Anoop picks the mode himself." So this module never redirects a
// message. It only detects the ONE case classification can be handled
// accurately (Anthropic's own stated bar): a message that unambiguously
// reads as forward-looking scalping-craft, arriving while the active
// tradingMode is 'standard' — and hands back a one-line suggestion Jessi's
// caller can choose to surface, never a silent reroute.
//
// FALSE-POSITIVE GUARD, BY DESIGN
// "How did my scalping look yesterday?" is a REVIEW question, not a live
// mode request — firing a mode-switch suggestion on it would be exactly the
// kind of noisy, wrong nudge that makes a feature like this get ignored or
// ripped out. reviewMarkers() suppresses the hint whenever the message reads
// as retrospective, regardless of how many scalping keywords are present.

const SCALP_SIGNALS = [
  /\bscalp(?:ing)?\b/i,
  /\bhold\s*time\b/i,
  /\bhow long (?:should|do|will) i hold\b/i,
  /\b(?:quick|fast)\s*(?:exit|entry)\b/i,
  /\b1\s?min(?:ute)?\s?(?:entry|chart|trigger)\b/i,
  /\bre-?entry\b/i,
  /\btick(?:s)?\s*profit\b/i,
  /\bmax\s*hold\b/i
];

// Retrospective/review phrasing — if present, this is a look-back question
// about a past session, not "help me do this right now."
const REVIEW_MARKERS = /\b(yesterday|last (?:session|week|day)|how (?:was|did)|review|earlier today|this morning|past \d+ (?:days?|trades?))\b/i;

function classifyChatIntent(text) {
  if (!text || typeof text !== 'string') return null;
  if (REVIEW_MARKERS.test(text)) return null;
  const hits = SCALP_SIGNALS.filter(re => re.test(text)).length;
  if (!hits) return null;
  // The bare word "scalp"/"scalping" is unambiguous on its own; anything else
  // needs at least two weaker signals together before we act on it.
  if (/\bscalp(?:ing)?\b/i.test(text)) return 'scalping';
  if (hits >= 2) return 'scalping';
  return null;
}

/**
 * @param {string|null} intent      output of classifyChatIntent()
 * @param {string} activeMode       rules.tradingMode ('standard' | 'scalper')
 * @returns {string|null}           a one-line advisory, or null when nothing to suggest
 */
function modeMismatchHint(intent, activeMode) {
  if (intent !== 'scalping') return null;
  if (activeMode === 'scalper') return null; // already in the right mode
  return 'This reads like a scalping-mechanics question — want me to switch you to Scalper mode? It applies your hold-time and re-entry rules, which Standard mode doesn\'t.';
}

// A simple cooldown so the same connection doesn't get nudged every message —
// callers own the store; this module stays stateless and testable. now()
// injectable for tests (Date.now() is fine for real callers).
function shouldSuppressForCooldown(lastHintAt, now, cooldownMs) {
  if (lastHintAt == null) return false;
  return (now - lastHintAt) < cooldownMs;
}

module.exports = { classifyChatIntent, modeMismatchHint, shouldSuppressForCooldown, SCALP_SIGNALS, REVIEW_MARKERS };
