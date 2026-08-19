// ── GO-verdict detection (2026-08-16, supports Pattern 03's voting variant) ──
// Pure classifier: does a Judge verdict's opening read as a GO? Scoped
// narrowly on purpose — the refutation pass this gates is extra latency on a
// live trading moment, so it must fire ONLY on the one outcome that actually
// authorizes risk. A false NO-GO costs a missed trade; a false GO costs real
// money. Matching "NO-GO"/"NO GO" first and excluding them is deliberate: a
// naive /\bgo\b/i alone matches inside "NO-GO" too.
function isGoVerdict(text) {
  if (!text || typeof text !== 'string') return false;
  const head = text.slice(0, 80); // "at the top" per JUDGE_PERSONA — no need to scan the whole verdict
  if (/\bno[\s-]?go\b/i.test(head)) return false;
  return /\bgo\b/i.test(head);
}

module.exports = { isGoVerdict };
