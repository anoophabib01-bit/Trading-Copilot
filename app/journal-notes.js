'use strict';
/**
 * journal-notes.js — turns the Daily Journal's saved notes into a context
 * block the coaching agents can actually read.
 *
 * WHY THIS EXISTS (2026-08-25)
 * ---------------------------
 * Anoop: "everything that i put in journal will be lesson and should come to
 * be in coaching in chat tomorrow and help me stick to this."
 *
 * It did not. The Journal tab's four fields — State of mind, Followed the
 * plan, Main mistake, the free note, and "One lesson to carry into tomorrow"
 * — were WRITE-ONLY. djSaveNote() sent them to server.js's 'note-save', which
 * wrote accounts/<slot>/notes.json, and the ONLY reader in the entire
 * codebase was the Journal tab itself re-rendering the same textarea he had
 * just typed into. buildJessiContext() folded in `trade_journal` (a different,
 * global store fed by the app_do "add_journal" action) and never touched
 * these. So the field literally labelled "carry into tomorrow" was the one
 * piece of the app that carried nothing.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * No scoring, no sentiment inference, no rewriting his words. His own
 * sentence is the highest-value thing in the block and it goes in verbatim
 * (truncated, never paraphrased). The one derived signal is a REPEAT count on
 * the mistake dropdown — a fixed enum, so counting it is arithmetic, not
 * interpretation — because a mistake named on three days is a pattern and a
 * mistake named once is noise. Same reasoning as the Day Recap's focus item.
 *
 * Pure and side-effect-free so it can be unit-tested without a running
 * server, same discipline as live-status.js and day-rollup.js.
 */

// Free text is his, but context is token-sensitive (buildJessiContext already
// caps history at 3 days for this reason). Truncate rather than drop: half a
// sentence in his own words beats a summary in mine.
const MAX_TEXT = 240;
const MAX_LESSON = 200;

function clip(s, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…';
}

function hasContent(note) {
  if (!note || typeof note !== 'object') return false;
  return !!(clip(note.lesson, MAX_LESSON) || clip(note.text, MAX_TEXT)
    || clip(note.mood, 40) || clip(note.mistake, 40) || clip(note.followedPlan, 10)
    // 2026-09-19: a day where he filled in ONLY the loss-journal fields is not
    // an empty day — treating it as one would hide exactly what he bothered to write.
    || clip(note.entryCriteria, MAX_TEXT) || clip(note.exitCriteria, MAX_TEXT)
    || clip(note.stateAtEntry, 40) || clip(note.stateNow, 40));
}

/**
 * Dated entries, newest first, for days STRICTLY BEFORE `todayKey`.
 *
 * Strictly before is the point: this is what he wrote about days that are
 * finished. Today's own note is written at the end of today, so folding it in
 * would mostly show him a blank he has not filled yet — and on the day he
 * does fill it, quoting it back mid-session is not coaching, it is echo.
 */
function recentNotes(notes, todayKey, limit) {
  if (!notes || typeof notes !== 'object') return [];
  const n = Number.isInteger(limit) && limit > 0 ? limit : 3;
  return Object.keys(notes)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .filter(d => !todayKey || d < todayKey)
    .filter(d => hasContent(notes[d]))
    .sort((a, b) => (a < b ? 1 : -1))
    .slice(0, n)
    .map(d => ({ date: d, note: notes[d] }));
}

/**
 * The mistake he has named most often in the window, and how often — but only
 * when it actually repeats. A single occurrence is returned as null rather
 * than as a one-count "pattern", because presenting one bad day as a trend is
 * how a coaching line stops being believed.
 */
function repeatedMistake(notes, todayKey, windowDays) {
  const rows = recentNotes(notes, todayKey, Number.isInteger(windowDays) ? windowDays : 7);
  const freq = {};
  rows.forEach(r => {
    const m = clip(r.note.mistake, 40);
    // "none" is a real option in the dropdown and means he judged the day
    // clean. Counting it would let a run of good days surface as a
    // "REPEATED" mistake — the exact opposite of what happened.
    if (m && m !== '—' && m !== 'none') freq[m] = (freq[m] || 0) + 1;
  });
  let best = null;
  Object.keys(freq).forEach(m => { if (!best || freq[m] > freq[best]) best = m; });
  if (!best || freq[best] < 2) return null;
  return { mistake: best, count: freq[best], of: rows.length };
}

function formatOne(row) {
  const n = row.note || {};
  const bits = [];
  const mood = clip(n.mood, 40);
  const plan = clip(n.followedPlan, 10);
  const mistake = clip(n.mistake, 40);
  if (mood) bits.push('felt ' + mood);
  // The dropdown has THREE answers (yes / partly / no), not two. Collapsing
  // "partly" into "did NOT follow his plan" put words in his mouth that he
  // did not choose — caught on his real 2026-08-24 note, which says partly.
  // Every one of these is his own selection, so each is reported as itself.
  if (plan === 'yes') bits.push('followed his plan');
  else if (plan === 'no') bits.push('did NOT follow his plan');
  else if (plan) bits.push('followed his plan ' + plan);
  if (mistake) bits.push('main mistake: ' + mistake);
  const lines = ['- ' + row.date + (bits.length ? ' — ' + bits.join(' · ') : '')];
  const text = clip(n.text, MAX_TEXT);
  if (text) lines.push('  What he wrote: "' + text + '"');
  const lesson = clip(n.lesson, MAX_LESSON);
  if (lesson) lines.push('  Lesson he set for himself: "' + lesson + '"');
  // The loss-journal fields (two-journal split, 2026-09-19). Deva's point was
  // that a losing day needs data a winning day does not: the criteria he
  // actually applied, and his state at entry versus after the loss. Goes in
  // VERBATIM like every other field here — his own sentence is the signal, not
  // my summary of it, and an agent that rewrites it loses the only thing that
  // makes it land.
  const entry = clip(n.entryCriteria, MAX_TEXT);
  const exit = clip(n.exitCriteria, MAX_TEXT);
  if (entry) lines.push('  Entry criteria he recorded: "' + entry + '"');
  if (exit) lines.push('  Exit criteria he recorded: "' + exit + '"');
  const sEntry = clip(n.stateAtEntry, 40);
  const sNow = clip(n.stateNow, 40);
  if (sEntry || sNow) lines.push('  State at entry: ' + (sEntry || '—') + '  →  after the loss: ' + (sNow || '—'));
  return lines.join('\n');
}

/**
 * The full context block, or '' when he has written nothing yet.
 *
 * Shape: the most recent lesson gets its own heading, because that is the one
 * line he wrote specifically to be handed back to him today. Everything else
 * is supporting history.
 */
function formatJournalContext(notes, todayKey, opts) {
  const o = opts || {};
  const rows = recentNotes(notes, todayKey, o.limit || 3);
  if (!rows.length) return '';

  const parts = [];
  const latest = rows[0];
  const latestLesson = clip((latest.note || {}).lesson, MAX_LESSON);
  if (latestLesson) {
    parts.push('HIS OWN LESSON, written at the close of ' + latest.date + ', to be applied today:');
    parts.push('  "' + latestLesson + '"');
    // The instruction is about WHOSE words these are. An agent that rephrases
    // this into its own coaching voice loses the only thing that makes it
    // land — he recognises his own sentence and cannot argue with it.
    parts.push('Hold him to this today, in HIS words — quote it back, do not reword it into your own advice.');
    parts.push('');
  }

  parts.push('Recent journal entries (most recent first):');
  rows.forEach(r => parts.push(formatOne(r)));

  const rep = repeatedMistake(notes, todayKey, o.patternWindow || 7);
  if (rep) {
    parts.push('');
    parts.push('REPEATED: he has named "' + rep.mistake + '" as his main mistake on '
      + rep.count + ' of the last ' + rep.of + ' journalled days. That is the pattern to work on, '
      + 'not whatever happens to go wrong first today.');
  }
  return parts.join('\n');
}

/* ── The stick-rate scorecard (2026-08-25) ──────────────────────────────────
 * Anoop asked for this against the Journal tab specifically, where State of
 * Mind / Followed the Plan / Main Mistake already live.
 *
 * THE SIGNAL IT RECOVERS
 * ----------------------
 * A lesson you fixed and a lesson you keep re-learning look IDENTICAL in this
 * app today. Both are one line of text in one day's note. Nothing compares
 * today's note against the eleven before it, so the single most valuable
 * thing in the whole journal — "you have written this same sentence four
 * times" — is invisible, and stays invisible precisely because he keeps
 * dutifully writing it down.
 *
 * NO MODEL, NO SENTIMENT, NO INFERENCE ABOUT WHAT HE MEANT.
 * Three of the four fields are fixed dropdowns, so counting them is
 * arithmetic. The two free-text fields are compared by token overlap, which
 * is a blunt instrument used deliberately: it can say "these two sentences
 * share most of their words" and nothing more. It never rewrites, ranks, or
 * interprets his words — the sentences are always shown verbatim beside the
 * count so he judges the match himself. A wrong cluster then costs him a
 * raised eyebrow, not a false accusation he cannot check.
 */

// Words that carry no identity. Stripped before comparing so "start small
// tomorrow" and "I should start small for tomorrow" are recognised as the
// same lesson written twice, which is the entire point of the exercise.
const STOPWORDS = new Set(('a an the and or but if then than so to of for on in at by with from into ' +
  'i me my myself you your it its is am are was were be been being do does did doing have has had ' +
  'will would shall should can could may might must not no nor too very just now today tomorrow ' +
  'yesterday day days again more most some any all this that these those there here what when').split(' '));

function lessonTokens(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w && w.length > 2 && !STOPWORDS.has(w));
}

// Jaccard overlap of the two token SETS. Set-based, not sequence-based, so
// word order and padding do not matter — the same idea phrased two ways still
// matches, while two genuinely different lessons that happen to share one
// word do not.
function lessonSimilarity(a, b) {
  const A = new Set(lessonTokens(a));
  const B = new Set(lessonTokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach(w => { if (B.has(w)) inter++; });
  return inter / (A.size + B.size - inter);
}

// 0.5 = half the meaningful words shared. Tuned deliberately high: a MISSED
// repeat costs him one un-surfaced insight, while a FALSE repeat tells him he
// keeps re-learning something he only wrote once — which would make him trust
// the whole panel less. Err toward missing.
const LESSON_MATCH = 0.5;

/**
 * Group near-identical lessons across days. Newest first within a group,
 * groups ordered by how often they repeat.
 *
 * Every member's date and exact text is returned, never a merged paraphrase —
 * the UI shows him what it matched so he can dismiss a bad cluster on sight.
 */
function clusterLessons(notes, todayKey, opts) {
  const o = opts || {};
  const threshold = typeof o.threshold === 'number' ? o.threshold : LESSON_MATCH;
  const rows = recentNotes(notes, todayKey, o.limit || 60)
    .map(r => ({ date: r.date, text: clip((r.note || {}).lesson, MAX_LESSON) }))
    .filter(r => r.text && lessonTokens(r.text).length);
  const groups = [];
  rows.forEach(r => {
    // Compare against the group's FIRST (newest) member, not against every
    // member: chaining "similar to something similar" drifts a cluster away
    // from its own subject over enough entries.
    const g = groups.find(gr => lessonSimilarity(gr.items[0].text, r.text) >= threshold);
    if (g) g.items.push(r);
    else groups.push({ items: [r] });
  });
  return groups
    .map(g => ({ count: g.items.length, latest: g.items[0].date, first: g.items[g.items.length - 1].date, items: g.items }))
    .sort((a, b) => b.count - a.count || (a.latest < b.latest ? 1 : -1));
}

/**
 * "Followed the plan" over time, with a recent-vs-earlier split.
 *
 * The split is the only way this answers the question he is actually asking.
 * A flat lifetime percentage says what he has been; comparing the last N
 * journalled days against everything before them says whether it is CHANGING,
 * which is the whole reason to keep writing the note down.
 */
function planAdherence(notes, todayKey, opts) {
  const o = opts || {};
  const recentN = Number.isInteger(o.recent) && o.recent > 0 ? o.recent : 5;
  const rows = recentNotes(notes, todayKey, o.limit || 60)
    .map(r => clip((r.note || {}).followedPlan, 10))
    .filter(v => v === 'yes' || v === 'partly' || v === 'no');
  if (!rows.length) return null;
  const pct = list => (list.length ? Math.round((list.filter(v => v === 'yes').length / list.length) * 100) : null);
  const recent = rows.slice(0, recentN);
  const earlier = rows.slice(recentN);
  const recentPct = pct(recent);
  const earlierPct = earlier.length ? pct(earlier) : null;
  let trend = null;
  // A trend needs a real sample on BOTH sides. Comparing a 5-day window
  // against a single earlier day produced "improving" from 40% vs 0% on his
  // own data, where the 0% was one day. One day is not a baseline, and a
  // "you're improving" that is actually noise is the fastest way to make him
  // stop believing the panel.
  if (earlierPct !== null && recent.length >= 2 && earlier.length >= 2) {
    if (recentPct > earlierPct + 10) trend = 'improving';
    else if (recentPct < earlierPct - 10) trend = 'slipping';
    else trend = 'flat';
  }
  return {
    total: rows.length,
    yes: rows.filter(v => v === 'yes').length,
    partly: rows.filter(v => v === 'partly').length,
    no: rows.filter(v => v === 'no').length,
    pct: pct(rows),
    recentPct, recentN: recent.length,
    earlierPct, earlierN: earlier.length,
    trend,
  };
}

/**
 * Per named mistake: when he FIRST named it, and how often it has come back
 * since. "Named on 12 Aug, back 3 times in the 7 days since" is the stick
 * rate — it is what separates a lesson that landed from one that did not.
 */
function mistakeRecurrence(notes, todayKey, opts) {
  const o = opts || {};
  const rows = recentNotes(notes, todayKey, o.limit || 60)
    .map(r => ({ date: r.date, mistake: clip((r.note || {}).mistake, 40) }))
    .filter(r => r.mistake && r.mistake !== '\u2014' && r.mistake !== 'none');
  const by = {};
  rows.forEach(r => {
    (by[r.mistake] || (by[r.mistake] = [])).push(r.date);
  });
  return Object.keys(by).map(m => {
    const dates = by[m].slice().sort();          // oldest first
    const first = dates[0];
    // Journalled days strictly after the day it was first named. Denominator
    // is journalled days, not calendar days — a day he did not write up is a
    // day this cannot speak for, and quietly counting it as clean would
    // flatter the number.
    const since = recentNotes(notes, todayKey, o.limit || 60).filter(r => r.date > first).length;
    return { mistake: m, count: dates.length, first, latest: dates[dates.length - 1], sinceDays: since, recurred: dates.length - 1 };
  }).sort((a, b) => b.count - a.count);
}

/**
 * The whole panel, as data. Returns null when there is nothing journalled —
 * an empty scorecard implying "all clear" would be worse than no panel.
 */
function buildScorecard(notes, todayKey, opts) {
  const o = opts || {};
  const rows = recentNotes(notes, todayKey, o.limit || 60);
  if (!rows.length) return null;
  const clusters = clusterLessons(notes, todayKey, o).filter(g => g.count > 1);
  const mistakes = mistakeRecurrence(notes, todayKey, o).filter(m => m.count > 1);
  return {
    journalledDays: rows.length,
    repeatedLessons: clusters,
    adherence: planAdherence(notes, todayKey, o),
    repeatedMistakes: mistakes,
    // The headline is the repeat he has written most often, because that is
    // the sentence he has proven he cannot make stick on his own.
    headline: clusters.length ? clusters[0] : null,
  };
}

/** Agent context. '' when there is nothing worth saying. */
function formatScorecardContext(notes, todayKey, opts) {
  const sc = buildScorecard(notes, todayKey, opts);
  if (!sc) return '';
  const out = [];
  if (sc.headline) {
    out.push('He has written this same lesson ' + sc.headline.count + ' times ('
      + sc.headline.items.map(i => i.date).join(', ') + '):');
    sc.headline.items.slice(0, 3).forEach(i => out.push('  ' + i.date + ': "' + i.text + '"'));
    out.push('Writing it again is not the fix. Say the count out loud and ask what makes THIS time different.');
  }
  if (sc.adherence && sc.adherence.trend) {
    out.push('Followed-the-plan: ' + sc.adherence.pct + '% across ' + sc.adherence.total
      + ' journalled days; last ' + sc.adherence.recentN + ' at ' + sc.adherence.recentPct
      + '% vs ' + sc.adherence.earlierPct + '% before that (' + sc.adherence.trend + ').');
  }
  sc.repeatedMistakes.slice(0, 3).forEach(m => {
    out.push('"' + m.mistake + '" first named ' + m.first + ', back ' + m.recurred
      + ' more time' + (m.recurred === 1 ? '' : 's') + ' across the ' + m.sinceDays + ' journalled days since.');
  });
  return out.join(String.fromCharCode(10));
}

const EXPORTS = {
  formatJournalContext, recentNotes, repeatedMistake,
  buildScorecard, formatScorecardContext, clusterLessons, planAdherence,
  mistakeRecurrence, lessonSimilarity, lessonTokens, LESSON_MATCH,
  _internal: { clip, hasContent, formatOne, MAX_TEXT, MAX_LESSON },
};

// Dual-mode export (2026-08-25). server.js folds the scorecard into agent
// context; the Journal tab renders the same numbers. ONE definition, or the
// panel and Jessi drift into telling him two different things about the same
// six days — the exact failure this file exists to report on.
if (typeof module !== 'undefined' && module.exports) module.exports = EXPORTS;
if (typeof window !== 'undefined') window.JournalNotes = EXPORTS;
