// ── Bias adherence tracker (2026-08-13) ───────────────────────────────────────
// Anoop, verbatim: "every time I complete the checklist and click certain things
// … especially the daily bias and 4hr time frame and 1hr time frame, I should
// follow the trade direction according to it. 70% to 80% should be in the same
// direction. for me to follow i should get proof … compare it with my p&L and
// crosscheck if my pre-trade was correct or wrong … grow this as a matrix for
// market understanding."
//
// WHY THIS COULD NOT EXIST BEFORE TODAY
// The pre-trade checklist record used to be {date, score, tier}. The declared
// bias / 4H / 1H were collected in the UI and thrown away. As of 2026-08-13 the
// record carries them (renderer/app.js ckWriteRecord), so a declaration can
// finally be compared against what he actually did.
//
// THE TWO MEASUREMENTS — deliberately kept apart
//   ADHERENCE = did he trade the direction he declared?      (discipline)
//   ACCURACY  = was the direction he declared actually right? (market read)
// Collapsing them into one "score" destroys the only interesting information,
// because the two failure modes need opposite responses: bad adherence means
// tighten the rules, bad accuracy means the rules are fine and the READ needs
// work. And the dangerous cell is neither — it is high P&L on LOW adherence,
// i.e. he broke his own plan and got paid for it, which is the lesson that
// ends accounts.
//
//        QUADRANT MATRIX (per day)
//                       read RIGHT              read WRONG
//        followed  │  EARNED_IT            │  HONEST_MISS
//        broke     │  GOT_AWAY_WITH_IT ⚠   │  DOUBLE_FAILURE ✗
//
// Pure functions only — no fs, no DOM, no network. Callers pass data in.

// Direction of record — Anoop's call, 2026-08-13: the Daily Bias field wins.
// 4H and 1H are CONTEXT: when they disagree with the daily call the direction
// still stands, but confidence drops. They never veto. (The alternative — all
// three must agree or the day is NO-DIRECTION — was considered and rejected as
// too harsh, though note his own checklist carries the item "4H and 1H in the
// same direction — no trade if they disagree", so a 'partial' day is one where
// his own written rule and his declared bias are in tension. formatContext()
// says so out loud rather than hiding it.)
const DIR_FROM_BIAS = {
  'bullish': 'LONG',
  'bearish': 'SHORT'
};

function normBias(v) {
  return String(v || '').trim().toLowerCase();
}

function directionOfRecord(ck) {
  ck = ck || {};
  const daily = normBias(ck.bias);
  const dir = DIR_FROM_BIAS[daily] || null;
  const h4 = DIR_FROM_BIAS[normBias(ck.h4)] || null;
  const h1 = DIR_FROM_BIAS[normBias(ck.h1)] || null;
  const agree = [h4, h1].filter(d => d && d === dir).length;
  const disagree = [h4, h1].filter(d => d && d !== dir).length;

  let confidence;
  if (!dir) confidence = 'none';
  else if (disagree > 0) confidence = 'contradicted';   // an HTF explicitly points the other way
  else if (agree === 2) confidence = 'full';            // daily + 4H + 1H all one way
  else confidence = 'partial';                          // something was Conflicted / blank

  return {
    dir: dir,
    daily: ck.bias || '',
    h4: ck.h4 || '',
    h1: ck.h1 || '',
    agree: agree,
    disagree: disagree,
    confidence: confidence
  };
}

// Adherence for one day. `trades` is the day's array from day_trades.json:
// { t, x, size, pnl, side: 'LONG'|'SHORT', flags: [...] }
function dayAdherence(ck, trades, rules) {
  rules = rules || {};
  const cfg = rules.biasAdherence || {};
  const minTrades = cfg.minTradesToJudge != null ? cfg.minTradesToJudge : 2;
  const rec = directionOfRecord(ck);
  const all = Array.isArray(trades) ? trades.filter(Boolean) : [];
  const list = all.filter(t => t.side);
  // ── Rows with no side are COUNTED, not just dropped (2026-08-31) ────────
  // Dropping them silently is how a real violation vanished: on 2026-08-31
  // the broker feed lost trade-level detail and wrote balance-move rows with
  // side:null, so a day of 2 LONG / 8 SHORT against a declared LONG bias and
  // a 75% target filtered down to zero judgeable trades and reported nothing
  // at all. Nothing reads as compliance. A rule that cannot be measured must
  // say so out loud — see trust-protocol.js check T3.
  const unknownSide = all.length - list.length;

  const aligned = list.filter(t => rec.dir && t.side === rec.dir);
  const counter = list.filter(t => rec.dir && t.side !== rec.dir);
  const sum = arr => Math.round(arr.reduce((a, t) => a + (t.pnl || 0), 0) * 100) / 100;

  const total = list.length;
  const pct = (rec.dir && total) ? Math.round((aligned.length / total) * 100) : null;

  return {
    date: ck && ck.date ? ck.date : null,
    direction: rec,
    total: total,
    alignedN: aligned.length,
    counterN: counter.length,
    alignedPnl: sum(aligned),
    counterPnl: sum(counter),
    netPnl: sum(list),
    adherencePct: pct,
    // Not enough trades to call it a pattern — one counter-trend scratch on a
    // 1-trade day is not "0% adherence", it is noise.
    // How many rows could not be judged at all, and whether that is the
    // whole day. A caller must be able to tell "he complied" from "we could
    // not tell", which `adherencePct: null` alone does not distinguish.
    unknownSide: unknownSide,
    unknownSideAll: all.length > 0 && list.length === 0,
    judged: rec.dir != null && total >= minTrades,
    counterTrades: counter
  };
}

// Was the declared read RIGHT? Proxy: what the trades taken IN that direction
// actually did. This is an honest proxy, not ground truth — it cannot see the
// trades he didn't take, and a right read can still be executed badly. Named
// `readVerdict` rather than `accuracy` so nobody downstream mistakes it for a
// measurement of the market itself.
function readVerdict(day) {
  if (!day || !day.direction.dir) return 'UNKNOWN';
  if (day.alignedN === 0) return 'UNTESTED';       // declared a direction, never traded it
  if (day.alignedPnl > 0) return 'RIGHT';
  if (day.alignedPnl < 0) return 'WRONG';
  return 'FLAT';
}

const QUADRANT = {
  EARNED_IT: 'EARNED_IT',
  HONEST_MISS: 'HONEST_MISS',
  GOT_AWAY_WITH_IT: 'GOT_AWAY_WITH_IT',
  DOUBLE_FAILURE: 'DOUBLE_FAILURE',
  UNJUDGED: 'UNJUDGED'
};

function quadrantFor(day, rules) {
  if (!day || !day.judged) return QUADRANT.UNJUDGED;
  const cfg = (rules && rules.biasAdherence) || {};
  const target = cfg.targetPct != null ? cfg.targetPct : 75;
  const followed = day.adherencePct != null && day.adherencePct >= target;
  const verdict = readVerdict(day);

  // ORDER MATTERS. Checked before the UNTESTED bail-out below, because the
  // worst case in the whole matrix lands here: he declared a direction, took
  // ZERO trades in it, and made money going the other way. The read is
  // genuinely untestable (he never tried it) — but the DISCIPLINE verdict is
  // not ambiguous at all, and bailing to UNJUDGED made the most extreme
  // got-away-with-it day the one day the matrix said nothing about.
  // Caught by the precedentFor test, 2026-08-13.
  if (!followed && day.counterPnl > 0) return QUADRANT.GOT_AWAY_WITH_IT;

  if (verdict === 'UNTESTED' || verdict === 'UNKNOWN') return QUADRANT.UNJUDGED;
  const right = verdict === 'RIGHT';
  if (followed && right) return QUADRANT.EARNED_IT;
  if (followed && !right) return QUADRANT.HONEST_MISS;
  // Broke the plan and it cost him. (The profitable version already returned
  // GOT_AWAY_WITH_IT above.)
  return QUADRANT.DOUBLE_FAILURE;
}

// Whole-history matrix. ckHistory = array of checklist records,
// dayTrades = { 'YYYY-MM-DD': [trade, ...] }.
function buildMatrix(ckHistory, dayTrades, rules) {
  const hist = Array.isArray(ckHistory) ? ckHistory : [];
  const dt = dayTrades || {};
  const rows = hist
    .filter(e => e && e.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map(e => {
      const day = dayAdherence(e, dt[e.date], rules);
      day.quadrant = quadrantFor(day, rules);
      day.readVerdict = readVerdict(day);
      return day;
    });

  const judged = rows.filter(r => r.judged);
  const counts = { EARNED_IT: 0, HONEST_MISS: 0, GOT_AWAY_WITH_IT: 0, DOUBLE_FAILURE: 0, UNJUDGED: 0 };
  rows.forEach(r => { counts[r.quadrant] = (counts[r.quadrant] || 0) + 1; });

  const avgAdh = judged.length
    ? Math.round(judged.reduce((a, r) => a + r.adherencePct, 0) / judged.length)
    : null;

  // Does following the plan actually pay HIM? The single most persuasive number
  // available, because it is computed from his own trades rather than asserted.
  const allAlignedPnl = Math.round(rows.reduce((a, r) => a + r.alignedPnl, 0) * 100) / 100;
  const allCounterPnl = Math.round(rows.reduce((a, r) => a + r.counterPnl, 0) * 100) / 100;
  const alignedTrades = rows.reduce((a, r) => a + r.alignedN, 0);
  const counterTrades = rows.reduce((a, r) => a + r.counterN, 0);

  return {
    rows: rows,
    counts: counts,
    daysJudged: judged.length,
    avgAdherencePct: avgAdh,
    alignedTrades: alignedTrades,
    counterTrades: counterTrades,
    alignedPnl: allAlignedPnl,
    counterPnl: allCounterPnl,
    alignedPerTrade: alignedTrades ? Math.round((allAlignedPnl / alignedTrades) * 100) / 100 : null,
    counterPerTrade: counterTrades ? Math.round((allCounterPnl / counterTrades) * 100) / 100 : null
  };
}

// Find the closest past precedent for what he is doing right now, so the
// reminder can cite a real day instead of a principle. He asked for "proof".
function precedentFor(matrix, quadrant, excludeDate) {
  if (!matrix || !Array.isArray(matrix.rows)) return null;
  const hits = matrix.rows.filter(r => r.quadrant === quadrant && r.date !== excludeDate);
  if (!hits.length) return null;
  return hits[hits.length - 1]; // most recent
}

const money = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round((n || 0) * 100) / 100).toLocaleString();

// The post-checklist reminder. Fires once, right after he presses DONE.
function formatPostChecklist(ck, matrix, rules) {
  const cfg = (rules && rules.biasAdherence) || {};
  const target = cfg.targetPct != null ? cfg.targetPct : 75;
  const rec = directionOfRecord(ck);
  const out = [];

  if (!rec.dir) {
    out.push('You did not declare a tradeable Daily Bias today (' + (rec.daily || 'blank') + '). Without a direction of record there is nothing to hold you to — set the bias before your first entry.');
    return out.join('\n');
  }

  out.push('📌 Direction of record today: **' + rec.dir + '** (Daily ' + rec.daily + ' · 4H ' + (rec.h4 || '—') + ' · 1H ' + (rec.h1 || '—') + ').');
  out.push('Target: at least ' + target + '% of today\'s trades ' + rec.dir + '.');

  if (rec.confidence === 'contradicted') {
    out.push('⚠ One of your higher timeframes points the OTHER way. Your own checklist says "4H and 1H in the same direction — no trade if they disagree". Either resolve it or size down.');
  } else if (rec.confidence === 'partial') {
    out.push('Note: ' + (normBias(rec.h1) === 'conflicted' ? '1H' : '4H') + ' is Conflicted, so this is a partial-confidence read, not a full one.');
  }

  if (matrix && matrix.daysJudged > 0) {
    out.push('');
    out.push('Your record so far: ' + matrix.avgAdherencePct + '% average adherence over ' + matrix.daysJudged + ' judged day(s).');
    if (matrix.alignedPerTrade != null && matrix.counterPerTrade != null) {
      out.push('In-direction trades: ' + money(matrix.alignedPerTrade) + '/trade. Counter-trend: ' + money(matrix.counterPerTrade) + '/trade.');
    }
    const gotAway = matrix.counts.GOT_AWAY_WITH_IT || 0;
    if (gotAway > 0) {
      out.push('⚠ ' + gotAway + ' day(s) where you broke your direction and still made money. That is the one that teaches the wrong lesson — do not let today be another.');
    }
  }
  return out.join('\n');
}

// The all-day cross-check, injected into Jessi's context on every chat turn so
// she can answer against it instead of guessing.
function formatContext(ck, todayTrades, matrix, rules) {
  const cfg = (rules && rules.biasAdherence) || {};
  if (cfg.enabled === false) return '';
  const target = cfg.targetPct != null ? cfg.targetPct : 75;
  const warn = cfg.warnPct != null ? cfg.warnPct : 60;
  if (!ck) return 'BIAS ADHERENCE: no pre-trade checklist recorded today — no direction of record, so nothing to hold him to.';

  const day = dayAdherence(ck, todayTrades, rules);
  const rec = day.direction;
  const lines = [];
  lines.push('BIAS ADHERENCE (today):');
  if (!rec.dir) {
    lines.push('- No tradeable Daily Bias declared (' + (rec.daily || 'blank') + ').');
    return lines.join('\n');
  }
  lines.push('- Declared direction: ' + rec.dir + ' (Daily ' + rec.daily + ' · 4H ' + (rec.h4 || '—') + ' · 1H ' + (rec.h1 || '—') + ', confidence ' + rec.confidence + ').');
  lines.push('- Target ' + target + '% of trades in that direction.');
  if (day.total === 0) {
    lines.push('- No trades ingested yet today.');
  } else {
    lines.push('- So far: ' + day.alignedN + '/' + day.total + ' in-direction (' + day.adherencePct + '%), ' + day.counterN + ' against.');
    lines.push('- In-direction P&L ' + money(day.alignedPnl) + ' · counter-trend P&L ' + money(day.counterPnl) + ' · net ' + money(day.netPnl) + '.');
    if (day.judged && day.adherencePct < warn) {
      lines.push('- ⚠ BELOW his own ' + warn + '% floor. Name it plainly.');
    }
    const q = quadrantFor(day, rules);
    if (q === QUADRANT.GOT_AWAY_WITH_IT) {
      lines.push('- ⚠ Today is currently GOT AWAY WITH IT: he broke his declared direction and is UP on those trades. Do NOT congratulate the P&L. This is the pattern that ends accounts.');
    } else if (q === QUADRANT.DOUBLE_FAILURE) {
      lines.push('- ✗ Today is currently DOUBLE FAILURE: wrong read AND traded against it.');
    } else if (q === QUADRANT.HONEST_MISS) {
      lines.push('- Today is an HONEST MISS: he followed his plan and the read was wrong. Grade the process a win; the READ needs work, not the rules.');
    } else if (q === QUADRANT.EARNED_IT) {
      lines.push('- ✓ Today is EARNED IT: right read, followed it. Say so — this is the one to repeat.');
    }
  }
  if (matrix && matrix.daysJudged > 0) {
    lines.push('- Lifetime: ' + matrix.avgAdherencePct + '% avg adherence over ' + matrix.daysJudged + ' day(s); '
      + 'in-direction ' + money(matrix.alignedPerTrade) + '/trade vs counter-trend ' + money(matrix.counterPerTrade) + '/trade.');
    lines.push('- Quadrants: earned ' + matrix.counts.EARNED_IT + ' · honest miss ' + matrix.counts.HONEST_MISS
      + ' · got-away-with-it ' + matrix.counts.GOT_AWAY_WITH_IT + ' · double failure ' + matrix.counts.DOUBLE_FAILURE + '.');
    const prec = precedentFor(matrix, quadrantFor(day, rules), day.date);
    if (prec) {
      lines.push('- Closest precedent: ' + prec.date + ' — ' + prec.adherencePct + '% adherence, net ' + money(prec.netPnl) + '. Cite it if it helps him see the pattern.');
    }
  }
  return lines.join('\n');
}

module.exports = {
  directionOfRecord, dayAdherence, readVerdict, quadrantFor, buildMatrix,
  precedentFor, formatPostChecklist, formatContext, QUADRANT
};
