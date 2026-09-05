'use strict';
/* ── The mind log — Alignment and Lessons, merged ───────────────────────────
 * 2026-08-25. Anoop: "how is this different from alignment tab?" then
 * "can we merger both and make it one ? close both gaps but keep both".
 *
 * WHAT WAS ACTUALLY WRONG
 * -----------------------
 * Two tabs held the same kind of thing — his own dated free text about
 * himself — and treated it completely differently:
 *
 *   Alignment  reached SEVEN agent call sites (text chat, voice, the Analysis
 *              agent, the PO3/Debate agent, the Scalper, and buildJessiContext
 *              twice). The only free text in the app that reaches voice.
 *   Lessons    reached ONE, and only if the lesson carried an armed detector.
 *              A plain written lesson was invisible to every agent.
 *
 * So for anything not expressible as a mechanical condition, Alignment was
 * strictly better than Lessons: identical content, seven readers instead of
 * zero. That is not a design, it is an oversight. Meanwhile Alignment had the
 * mirror-image hole — an entry there could never be armed, however
 * checkable it was.
 *
 * BOTH KEPT, BECAUSE THE DISTINCTION IS REAL
 * ------------------------------------------
 * Merging the SURFACE is right; merging the two KINDS would not be. They
 * differ by lifespan, and lifespan is what decides how an agent should use
 * one:
 *
 *   state   "where my head is today" — TRUE OF A PERIOD. His 18 Aug entry
 *           (drained, dopamine, size confusing him) describes a stretch of
 *           time. Handed back six months later as a standing fact it would be
 *           actively wrong, so agents get only the most recent few.
 *   lesson  "what I have learned" — MEANT TO OUTLAST THE DAY. "Sizing up
 *           while losing blows accounts" is as true next year. These stay in
 *           context regardless of age, and only these can be armed.
 *
 * One tab, one store, one timeline; two kinds, because a note that expires
 * and a law that does not must not be quoted back the same way.
 *
 * MIGRATION IS NON-DESTRUCTIVE BY CONSTRUCTION. align_notes.json and
 * lessons_log.json are READ and left exactly where they are. His 18 Aug entry
 * is long and irreplaceable; nothing here is worth risking it for tidiness.
 *
 * Pure and side-effect-free. UMD: window.MindLog in the renderer, CommonJS on
 * the server — one definition, so the tab and the agents cannot drift.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MindLog = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KIND_STATE = 'state';
  const KIND_LESSON = 'lesson';

  // Standing lessons are permanent, so without a cap the context block grows
  // without bound and eventually crowds out live trading data in every one of
  // the seven places this lands — including the voice budget. Newest first,
  // so what he most recently decided about himself always survives the cut.
  const LESSON_CONTEXT_CAP = 8;

  const str = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const numOr = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

  function dateOf(e) {
    if (!e) return '?';
    if (e.ts) { const d = new Date(e.ts); if (!isNaN(d)) return d.toISOString().slice(0, 10); }
    if (numOr(e.id, null)) { const d = new Date(e.id); if (!isNaN(d)) return d.toISOString().slice(0, 10); }
    return '?';
  }

  function normalize(raw, kind) {
    if (!raw || !str(raw.text)) return null;
    const e = {
      id: numOr(raw.id, null) || Date.parse(raw.ts) || 0,
      ts: raw.ts || (numOr(raw.id, null) ? new Date(raw.id).toISOString() : null),
      text: String(raw.text),
      kind: raw.kind === KIND_LESSON || raw.kind === KIND_STATE ? raw.kind : kind,
    };
    // Only a lesson can carry a watch. A "where my head's at" note is a
    // description of a period, not a rule — arming one would mean the app
    // enforcing a mood.
    if (e.kind === KIND_LESSON) {
      if (raw.detector) e.detector = raw.detector;
      e.promoted = !!raw.promoted;
      e.fireCount = numOr(raw.fireCount, 0);
      e.lastFiredAt = numOr(raw.lastFiredAt, null);
      if (numOr(raw.armedAt, null)) e.armedAt = raw.armedAt;
    }
    return e;
  }

  /**
   * Build the merged log from the two legacy stores. Neither input is
   * mutated and neither file is deleted by anything here — this only decides
   * what the merged view contains.
   *
   * De-duped on id+text: running the migration twice (a race between the
   * server's first load and the tab's, both finding no mind_log) must not
   * double every entry he has ever written.
   */
  function migrate(alignList, lessonsList) {
    const out = [];
    const seen = new Set();
    const push = (raw, kind) => {
      const e = normalize(raw, kind);
      if (!e) return;
      const key = e.kind + '|' + e.id + '|' + str(e.text).slice(0, 120);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(e);
    };
    (Array.isArray(lessonsList) ? lessonsList : []).forEach((l) => push(l, KIND_LESSON));
    (Array.isArray(alignList) ? alignList : []).forEach((a) => push(a, KIND_STATE));
    return sortNewestFirst(out);
  }

  function sortNewestFirst(list) {
    return (Array.isArray(list) ? list : [])
      .filter(Boolean)
      .slice()
      .sort((a, b) => (numOr(b.id, 0) - numOr(a.id, 0)));
  }

  /** Everything, normalized and ordered. Safe on a raw file read. */
  function load(list) {
    return sortNewestFirst((Array.isArray(list) ? list : [])
      .map((e) => normalize(e, KIND_STATE))
      .filter(Boolean));
  }

  function states(list, limit) {
    const s = load(list).filter((e) => e.kind === KIND_STATE);
    return Number.isInteger(limit) && limit > 0 ? s.slice(0, limit) : s;
  }

  function lessons(list, limit) {
    const s = load(list).filter((e) => e.kind === KIND_LESSON);
    return Number.isInteger(limit) && limit > 0 ? s.slice(0, limit) : s;
  }

  /** Armed lessons, in the shape armed-detectors.js expects. */
  function armable(list) {
    return lessons(list).filter((e) => e.detector);
  }

  /**
   * The context block for the agents. Two labelled sections, because an agent
   * told "he wrote this" needs to know whether it is a mood from Tuesday or a
   * law he set for himself.
   *
   * Returns '' when there is nothing — an empty heading reads as "he has
   * never written anything", which is a different claim from "nothing today".
   */
  function formatContext(list, opts) {
    const o = opts || {};
    const stateLimit = Number.isInteger(o.stateLimit) && o.stateLimit > 0 ? o.stateLimit : 3;
    const lessonLimit = Number.isInteger(o.lessonLimit) && o.lessonLimit > 0 ? o.lessonLimit : LESSON_CONTEXT_CAP;
    const st = states(list, stateLimit);
    const ls = lessons(list, lessonLimit);
    if (!st.length && !ls.length) return '';
    const parts = [];
    if (st.length) {
      parts.push('WHERE HIS HEAD IS (his own dated reflections — recent, and they expire; do not quote an old one as if it were today):');
      st.forEach((e) => parts.push('- [' + dateOf(e) + '] ' + e.text));
    }
    if (ls.length) {
      if (parts.length) parts.push('');
      parts.push('STANDING LESSONS he has set for himself (these do NOT expire — treat them as his own rules, quote them in his words):');
      ls.forEach((e) => {
        const armed = e.promoted && e.detector;
        const fired = numOr(e.fireCount, 0);
        // Whether it is armed changes what an agent should DO with it: an
        // armed lesson already alerts him on its own, so repeating it
        // unprompted is nagging; an unarmed one has no other voice.
        const tag = armed
          ? ' [ARMED — the app checks this live' + (fired ? ', has caught him ' + fired + 'x' : ', never fired yet') + ']'
          : '';
        parts.push('- [' + dateOf(e) + '] ' + e.text + tag);
      });
    }
    return parts.join('\n');
  }

  return {
    KIND_STATE, KIND_LESSON, LESSON_CONTEXT_CAP,
    migrate, load, states, lessons, armable, formatContext, normalize, dateOf,
    _internal: { sortNewestFirst },
  };
});
