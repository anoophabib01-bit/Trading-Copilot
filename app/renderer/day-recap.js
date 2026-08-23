'use strict';
// ═══════════════════════════════════════════════════════════════════════════════
// DAY RECAP — yesterday's mistakes, in front of you before today starts
// (2026-08-22, Anoop: "create a day recap preview before starting new day so
//  that it reminds my mistakes from yesterday and i am aware of them on the
//  current trading day")
// ═══════════════════════════════════════════════════════════════════════════════
// Reads what the app ALREADY stores — copilot_gr_history (per-day discipline
// records) and insCoachNotes() (the same note generator the Insights tab uses).
// Nothing new has to be captured for this to work, and it stays consistent with
// Insights by construction rather than by duplicated logic.
//
// Shows once per IST trading day, on first load, before the session. The single
// amber FOCUS block is the whole point: ONE thing to fix today, chosen
// mechanically as the most-repeated recent mistake — not a wall of stats to
// skim past. That block is then pinned to the Checklist tab so it survives the
// twenty seconds the modal is open.
//
// Loaded after app.js, so insCoachNotes / insMoney / DOW / edToday / switchTab /
// addSystemMessage are all available. Every one of them is still called
// defensively — a recap that throws must never stop the app from starting.

const RECAP_SHOWN_KEY = 'copilot_recap_last_shown';
const RECAP_FOCUS_KEY = 'copilot_focus_item';

function recapEsc(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

// Normalises a coach note into a STABLE habit key.
//
// The obvious `note.split('—')[0]` does not work, and this is worth spelling out
// because the same mistake is live in insProse()'s "most-repeated mistake" line:
// most notes lead with the day's own count ("25 trades — over your 20 cap"), so
// 25/22/24 trades produce three different keys and a habit repeated every day
// looks like three unrelated one-offs. Stripping the digits is what makes a
// repeat detectable at all.
function recapNoteKey(text) {
  return String(text).split('—')[0]
    .replace(/\d+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Human-readable label for a key. Deliberately the FULL note, not the part
// before the dash: the half before the dash is only the count ("25 trades"),
// while the half after it carries the actual meaning ("over your 20 cap").
// Keeping the whole line means the focus block reads like the coaching note
// Anoop already recognises from the Insights tab.
function recapNoteLabel(text) {
  return String(text).trim();
}

function recapLoadHistory() {
  try { return JSON.parse(localStorage.getItem('copilot_gr_history') || '[]') || []; }
  catch (e) { return []; }
}

// The most recent day STRICTLY BEFORE today. "Yesterday" in trading terms is the
// last day actually traded — after a weekend or a day off that is not literally
// yesterday, and showing an empty recap for a non-trading day would train Anoop
// to dismiss this thing unread.
function recapLastTradedDay(today) {
  const hist = recapLoadHistory().filter(function (d) { return d && d.date && d.date < today; });
  if (!hist.length) return null;
  return hist.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; })[0];
}

// The one thing to fix today. Preference order: a habit repeated across the last
// 7 days beats a one-off from yesterday, because the repeat is the actual
// pattern — a single bad day can be noise, three in a week is a leak.
function recapFocusItem(day) {
  const notesFor = (typeof insCoachNotes === 'function') ? insCoachNotes : function () { return []; };
  const recent = recapLoadHistory().slice(-7);
  const freq = {};
  const label = {};
  recent.forEach(function (d) {
    (notesFor(d) || []).filter(function (n) { return n.c === 'bad'; }).forEach(function (n) {
      const k = recapNoteKey(n.t);
      if (!k) return;
      freq[k] = (freq[k] || 0) + 1;
      label[k] = recapNoteLabel(n.t);   // latest occurrence wins — freshest numbers
    });
  });
  const repeated = Object.keys(freq)
    .filter(function (k) { return freq[k] >= 2; })
    .sort(function (a, b) { return freq[b] - freq[a]; })[0];
  if (repeated) {
    return {
      text: label[repeated] + '  (' + freq[repeated] + ' of the last ' + recent.length +
            ' days — this is the pattern, not a one-off. Fix this one today.)',
      repeat: true
    };
  }
  const todayNotes = notesFor(day) || [];
  const bad = todayNotes.filter(function (n) { return n.c === 'bad'; });
  if (bad.length) return { text: bad[0].t, repeat: false };
  const warn = todayNotes.filter(function (n) { return n.c === 'warn'; });
  if (warn.length) return { text: warn[0].t, repeat: false };
  return { text: 'No rule breaks logged yesterday. Protect that — same process, same size.', repeat: false };
}

// ── Last trades / extremes / sizing (2026-08-22, Anoop) ──────────────────────
// "i need to know the last 2 trades exited price and direction and time of the
//  trade so that i can compare it with todays price action. i also need
//  information about highest profit and loss of previous day to make sure i
//  choose my contract size of today accordingly."
//
// Per-trade detail lives in copilot_day_trades[date] as
//   { t: entryMs, x: exitMs, size, pnl, g, flags, side, ep, xp, mp, hold }
// `xp` (exit price) and `mp` (signed points moved) have been stored since
// 2026-07-28, so historical days already carry them — nothing to backfill.
function recapDayTrades(dateStr) {
  try {
    const dt = JSON.parse(localStorage.getItem('copilot_day_trades') || '{}');
    return (dt && dt[dateStr]) || [];
  } catch (e) { return []; }
}

// The last N trades of the day, latest exit first.
function recapLastTrades(dateStr, n) {
  return recapDayTrades(dateStr)
    .slice()
    .sort(function (a, b) { return (b.x || 0) - (a.x || 0); })
    .slice(0, n || 2);
}

function recapTime(ms) {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit'
    });
  } catch (e) { return '—'; }
}

function recapPx(v) {
  return (typeof v === 'number' && v > 0) ? v.toFixed(2) : '—';
}

// Contract-size guidance for today, from yesterday's WORST single trade.
// The reasoning: the daily stop is only a real limit if one trade cannot reach
// it on its own. If yesterday's worst loss was already a large share of the
// day stop, the size that produced it is too big — regardless of how the day
// finished. This is the "max single loss ≈ 5 avg winners" problem from
// IMPROVEMENT_PLAN.md #6, turned into a number before the session instead of a
// post-mortem after it.
function recapSizeAdvice(day) {
  const acc = (typeof state !== 'undefined' && state.account) ? state.account : {};
  const mode = (typeof state !== 'undefined' && state.mode) ? state.mode : 'eval';
  const dayStop = Math.abs(mode === 'eval' ? (acc.evalDayStop || 300) : (acc.fundedDayStop || 200));
  const cap = 6;                                   // rules.json sizeCap
  const worst = Math.abs(day.worst || 0);          // worst SINGLE trade, from gr_history
  const usedSize = day.maxSize || 0;
  if (!worst || !dayStop) {
    return { size: null, text: 'No loss data for yesterday — start at 2–3 and size up only after the bias confirms.' };
  }
  const share = worst / dayStop;                   // how much of the day stop one trade ate
  let size, why;
  if (share >= 1) {
    size = 2;
    why = 'One trade lost ' + Math.round(share * 100) + '% of your whole day stop. That size is too big for your stop distance — start at 2.';
  } else if (share >= 0.5) {
    size = Math.max(2, Math.min(cap, Math.floor((usedSize || cap) / 2) || 2));
    why = 'Worst trade ate ' + Math.round(share * 100) + '% of the day stop. Halve your opener — start at ' + size + '.';
  } else if (share >= 0.25) {
    size = Math.max(2, Math.min(cap, (usedSize || 4) - 1));
    why = 'Worst trade was ' + Math.round(share * 100) + '% of the day stop — within range, but open one contract smaller than yesterday.';
  } else {
    size = Math.min(cap, Math.max(2, usedSize || 3));
    why = 'Worst trade was only ' + Math.round(share * 100) + '% of the day stop — risk was controlled. Same opener, same discipline.';
  }
  return { size: size, text: why };
}

// ── Quote of the day ─────────────────────────────────────────────────────────
// Drawn from the same five books already in the library (books-index.js), so
// the voice matches the coaching the rest of the app gives. Selected
// DETERMINISTICALLY from the date — the same quote all day, a new one tomorrow.
// Deliberately local rather than an API call: this must render instantly and
// work with no key, no network and no TradingView.
const RECAP_QUOTES = [
  ['The best traders have no ego. You have to swallow your pride and get out of the trade.', 'Tom Baldwin — Market Wizards'],
  ['I just wait until there is money lying in the corner, and all I have to do is go over there and pick it up.', 'Jim Rogers — Market Wizards'],
  ['The elements of good trading are cutting losses, cutting losses, and cutting losses.', 'Ed Seykota — Market Wizards'],
  ['You have to be willing to lose to win. Anything can happen.', 'Mark Douglas — Trading in the Zone'],
  ['The consistency you seek is in your mind, not in the markets.', 'Mark Douglas — Trading in the Zone'],
  ['Trading is not about being right. It is about how much you make when right and lose when wrong.', 'Trading in the Zone'],
  ['Losing a position is aggravating, whereas losing your nerve is devastating.', 'Ed Seykota'],
  ['I am always thinking about losing money as opposed to making money.', 'Paul Tudor Jones'],
  ['Risk comes from not knowing what you are doing.', 'Warren Buffett'],
  ['Amateurs think about how much money they can make. Professionals think about how much they could lose.', 'Jack Schwager — Stock Market Wizards'],
  ['The market does not owe you anything today. Your only job is to follow your process.', 'Prop Trading Secrets'],
  ['One good trade taken properly beats ten forced ones.', "TradeApp's Guide to Proprietary Trading"],
  ['Discipline is choosing between what you want now and what you want most.', 'Prop Trading Secrets'],
  ['A red day with a clean process is a win. A green day with a broken one is a loss waiting to be paid back.', 'Your own rulebook']
];

function recapQuoteFor(dateStr) {
  let h = 0;
  for (let i = 0; i < String(dateStr).length; i++) h = (h * 31 + dateStr.charCodeAt(i)) >>> 0;
  return RECAP_QUOTES[h % RECAP_QUOTES.length];
}

// ── Jessi's read on yesterday ────────────────────────────────────────────────
// Asked for explicitly: "advise from jessi as per my trades yesterday and how i
// should be treating today as."
//
// Two-stage by design. A mechanical read renders INSTANTLY from the numbers, so
// the recap is complete and useful with no API key, no network, and no waiting.
// Jessi's version then replaces it if a key is configured. The recap must never
// sit blank waiting on a model that may be rate-limited or unconfigured.
function recapMechanicalRead(day, size) {
  const bits = [];
  const pnl = day.pnl || 0;
  const disc = day.disc || 0;
  if (pnl > 0 && disc < 60) {
    bits.push('Yesterday paid you for bad habits — the most dangerous kind of green day. Today, treat the process as the score and ignore the P&L.');
  } else if (pnl > 0) {
    bits.push('Yesterday worked and the process held. Today is about repeating it, not upgrading it — same size, same setups.');
  } else if (disc >= 75) {
    bits.push('Red day, clean process. Nothing to fix mechanically; today is simply the next sample. Do not widen risk to win it back.');
  } else {
    bits.push('Red day and the process slipped with it. Today is a rebuild day — smallest size, one setup, one trade if that is all that prints.');
  }
  if ((day.revenge || 0) > 0) bits.push('There were ' + day.revenge + ' revenge re-entries. If you feel the urge to get straight back in after a loss today, that is the signal to stand up, not to click.');
  if ((day.flips || 0) >= 2) bits.push('You traded both directions inside 15 minutes. Pick one bias today and hold it.');
  if (size) bits.push('Start at ' + size + ' contracts and only add after two confirming closes.');
  return bits.join(' ');
}

function recapJessiPrompt(day, last, size) {
  const lines = last.map(function (t) {
    return '- ' + (t.side || '?') + ' ' + (t.size || '?') + ' lots, in ' + recapPx(t.ep) +
           ' out ' + recapPx(t.xp) + ' at ' + recapTime(t.x) + ' IST, P&L $' + Math.round(t.pnl || 0);
  }).join('\n');
  return 'This is my pre-session recap for today. Yesterday (' + day.date + '): ' +
    'net $' + Math.round(day.pnl || 0) + ' over ' + (day.n || 0) + ' trades, ' +
    (day.wins || 0) + ' wins / ' + (day.losses || 0) + ' losses, discipline ' + (day.disc || 0) + '%, ' +
    'best trade $' + Math.round(day.best || 0) + ', worst trade $' + Math.round(day.worst || 0) + ', ' +
    'max size ' + (day.maxSize || 0) + ', revenge re-entries ' + (day.revenge || 0) + ', ' +
    'direction flips ' + (day.flips || 0) + '.\n' +
    (lines ? 'My last 2 trades:\n' + lines + '\n' : '') +
    'The app suggests starting at ' + (size || '2') + ' contracts today.\n\n' +
    'In 3 short sentences, no preamble and no bullet points: tell me how I should treat TODAY ' +
    'based on that. Be specific about size and mindset, name the one habit to watch, and do not ' +
    'congratulate me for a green day if the process was broken.';
}

function recapRequestJessi(day, last, size) {
  const el = document.getElementById('recap-jessi-text');
  if (!el || !window.api || typeof window.api.sendJessiChat !== 'function') return;
  const label = document.getElementById('recap-jessi-label');
  if (label) label.textContent = 'JESSI — READING YESTERDAY…';
  window.api.sendJessiChat([{ role: 'user', content: recapJessiPrompt(day, last, size) }])
    .then(function (res) {
      // sendJessiChat resolves { text, answeredBy }, NOT a bare string. This
      // read it as a string, and since an object is truthy the empty-guard
      // passed too — so the recap rendered the literal "[object Object]"
      // under "JESSI — ON YESTERDAY". Fixed 2026-08-23 after seeing it on
      // screen. Still tolerates a bare string in case a caller changes back.
      const text = (res && typeof res === 'object') ? res.text : res;
      if (!text || !String(text).trim()) return;
      el.textContent = String(text).trim();
      if (label) label.textContent = 'JESSI — ON YESTERDAY';
    })
    .catch(function (e) {
      // Expected whenever no key is set or the model is rate-limited. The
      // mechanical read is already on screen, so this is genuinely non-fatal.
      if (label) label.textContent = 'TODAY’S READ';
      console.log('Jessi recap read unavailable:', e && e.message);
    });
}

function recapShouldShow(today) {
  try { if (localStorage.getItem(RECAP_SHOWN_KEY) === today) return false; } catch (e) {}
  return !!recapLastTradedDay(today);
}

function recapRender(day, today) {
  const money = (typeof insMoney === 'function') ? insMoney : function (n) { return '$' + Math.round(n); };
  const notesFor = (typeof insCoachNotes === 'function') ? insCoachNotes : function () { return []; };
  const notes = notesFor(day) || [];
  const bad = notes.filter(function (n) { return n.c === 'bad'; });
  const warn = notes.filter(function (n) { return n.c === 'warn'; });
  const good = notes.filter(function (n) { return n.c === 'good'; });

  const dEl = document.getElementById('recap-date');
  if (dEl) {
    const dow = (day.dow !== undefined && typeof DOW !== 'undefined') ? DOW[day.dow] + ' ' : '';
    dEl.textContent = dow + day.date;
  }

  // Process verdict, NOT a P&L verdict. The app's stated position — and the one
  // in the Claude agent's prompt — is that a green day with broken process is a
  // failed day. The badge has to reflect that or it teaches the wrong lesson.
  const v = document.getElementById('recap-verdict');
  if (v) {
    let label, bg, fg;
    if (bad.length === 0 && (day.disc || 0) >= 75) {
      label = 'CLEAN PROCESS'; bg = 'var(--green-dim)'; fg = 'var(--green)';
    } else if (bad.length >= 2) {
      label = 'PROCESS BROKE'; bg = 'var(--red-dim)'; fg = 'var(--red)';
    } else {
      label = 'PARTIAL SLIP'; bg = 'var(--amber-dim)'; fg = 'var(--amber)';
    }
    v.textContent = label;
    v.style.background = bg;
    v.style.color = fg;
  }

  const focus = recapFocusItem(day);
  try { localStorage.setItem(RECAP_FOCUS_KEY, JSON.stringify({ date: today, text: focus.text })); } catch (e) {}
  const f = document.getElementById('recap-focus');
  if (f) {
    f.innerHTML = '<div class="rf-label">' +
      (focus.repeat ? 'TODAY&#39;S ONE FIX — REPEATED PATTERN' : 'TODAY&#39;S ONE FIX') +
      '</div><div class="rf-text">' + recapEsc(focus.text) + '</div>';
  }

  const stats = [
    ['P&L', money(day.pnl || 0), (day.pnl || 0) >= 0 ? 'var(--green)' : 'var(--red)'],
    ['TRADES', String(day.n || 0), (day.n || 0) > 20 ? 'var(--red)' : ''],
    ['DISCIPLINE', (day.disc || 0) + '%',
      (day.disc || 0) >= 75 ? 'var(--green)' : (day.disc || 0) >= 50 ? 'var(--amber)' : 'var(--red)'],
    ['WIN / LOSS', (day.wins || 0) + ' / ' + (day.losses || 0), ''],
    // Best/worst SINGLE trade — the two numbers that decide today's size.
    ['BEST TRADE', money(day.best || 0), 'var(--green)'],
    ['WORST TRADE', money(day.worst || 0), 'var(--red)'],
    ['MAX SIZE', String(day.maxSize || 0), (day.maxSize || 0) > 6 ? 'var(--red)' : ''],
    ['REVENGE', String(day.revenge || 0), (day.revenge || 0) ? 'var(--red)' : '']
  ];
  const sEl = document.getElementById('recap-stats');
  if (sEl) {
    sEl.innerHTML = stats.map(function (row) {
      return '<div class="rs"><div class="rs-l">' + row[0] + '</div><div class="rs-v"' +
        (row[2] ? ' style="color:' + row[2] + '"' : '') + '>' + recapEsc(row[1]) + '</div></div>';
    }).join('');
  }

  // ── Contract size for today, from yesterday's worst single trade ──────────
  const advice = recapSizeAdvice(day);
  const szEl = document.getElementById('recap-size');
  if (szEl) {
    szEl.innerHTML = '<div class="rf-label" style="color:var(--text-dim)">TODAY’S STARTING SIZE</div>' +
      '<div class="recap-size-row">' +
        '<div class="recap-size-num">' + (advice.size !== null ? advice.size : '—') + '</div>' +
        '<div class="recap-size-why">' + recapEsc(advice.text) + '</div>' +
      '</div>';
  }

  // ── Last 2 exits, to compare against today's price action ─────────────────
  const last = recapLastTrades(day.date, 2);
  const ltEl = document.getElementById('recap-last-trades');
  if (ltEl) {
    if (!last.length) {
      ltEl.innerHTML = '<div class="recap-sec-title">LAST 2 TRADES</div>' +
        '<div class="recap-note warn">No per-trade detail stored for ' + recapEsc(day.date) +
        // Phase 4 (4.3): the live feed now writes this on its own — a missing
        // day means the app wasn't running when it closed, not a missing
        // upload. CSV reconciliation (4.5) is the backstop for exactly that.
        ' — the app wasn’t running for that day’s closes. Reconcile a CSV export to backfill it.</div>';
    } else {
      ltEl.innerHTML = '<div class="recap-sec-title">LAST 2 TRADES — COMPARE AGAINST TODAY’S PRICE</div>' +
        last.map(function (t) {
          const win = (t.pnl || 0) >= 0;
          const dir = (t.side || '?').toUpperCase();
          const hold = t.hold ? (t.hold < 90 ? t.hold + 's' : Math.round(t.hold / 60) + 'm') : '—';
          return '<div class="recap-trade">' +
            '<span class="rt-dir ' + (dir === 'LONG' ? 'long' : 'short') + '">' + recapEsc(dir) + '</span>' +
            '<span class="rt-px">' + recapPx(t.ep) + ' → <b>' + recapPx(t.xp) + '</b>' +
              (t.mp != null ? ' <span class="rt-pts">' + (t.mp > 0 ? '+' : '') + t.mp + ' pts</span>' : '') +
            '</span>' +
            '<span class="rt-meta">exit ' + recapTime(t.x) + ' IST · ' + (t.size || '?') + ' lots · ' + hold + '</span>' +
            '<span class="rt-pnl" style="color:' + (win ? 'var(--green)' : 'var(--red)') + '">' +
              money(t.pnl || 0) + '</span>' +
          '</div>';
        }).join('');
    }
  }

  // ── Jessi's read (mechanical first, model second) ─────────────────────────
  const jEl = document.getElementById('recap-jessi-text');
  if (jEl) jEl.textContent = recapMechanicalRead(day, advice.size);
  recapRequestJessi(day, last, advice.size);

  // ── Quote ─────────────────────────────────────────────────────────────────
  const q = recapQuoteFor(today);
  const qEl = document.getElementById('recap-quote');
  if (qEl) {
    qEl.innerHTML = '<div class="recap-quote-text">“' + recapEsc(q[0]) + '”</div>' +
                    '<div class="recap-quote-src">— ' + recapEsc(q[1]) + '</div>';
  }

  const mEl = document.getElementById('recap-mistakes');
  if (mEl) {
    const list = bad.concat(warn);
    mEl.innerHTML = list.length
      ? '<div class="recap-sec-title">WHAT WENT WRONG</div>' +
        list.map(function (n) { return '<div class="recap-note ' + n.c + '">' + recapEsc(n.t) + '</div>'; }).join('')
      : '';
  }

  // Affirming good decisions as loudly as flagging bad ones is an explicit rule
  // in the co-pilot's own prompt — a recap that only ever scolds gets ignored.
  const gEl = document.getElementById('recap-good');
  if (gEl) {
    gEl.innerHTML = good.length
      ? '<div class="recap-sec-title">WHAT WENT RIGHT — KEEP DOING THIS</div>' +
        good.map(function (n) { return '<div class="recap-note good">' + recapEsc(n.t) + '</div>'; }).join('')
      : '';
  }
}

function recapDismiss(skipped) {
  const today = (typeof edToday === 'function') ? edToday() : '';
  try { localStorage.setItem(RECAP_SHOWN_KEY, today); } catch (e) {}
  const el = document.getElementById('recap-overlay');
  if (el) el.classList.remove('visible');
  if (!skipped) {
    let focus = null;
    try { focus = JSON.parse(localStorage.getItem(RECAP_FOCUS_KEY) || 'null'); } catch (e) {}
    if (focus && focus.text && typeof addSystemMessage === 'function') {
      addSystemMessage('Today’s one fix: ' + focus.text);
    }
    // Hand off to the pre-session ritual. The recap's job is to lead into the
    // checklist, not to be read and closed.
    if (typeof switchTab === 'function') { try { switchTab('checklist'); } catch (e) {} }
  }
  recapPinFocus();
}

// Pins the focus item to the top of the Checklist tab so it stays visible for
// the whole session. This is the part that makes the recap a loop rather than a
// notification — the fix is in view at the moment the entry decision is made.
function recapPinFocus() {
  let focus = null;
  try { focus = JSON.parse(localStorage.getItem(RECAP_FOCUS_KEY) || 'null'); } catch (e) {}
  if (!focus || !focus.text) return;
  const host = document.getElementById('tab-checklist') ||
               document.getElementById('checklist-tab') ||
               document.querySelector('[data-tab-content="checklist"]');
  if (!host) return;
  let pin = document.getElementById('ck-focus-pin');
  if (!pin) {
    pin = document.createElement('div');
    pin.id = 'ck-focus-pin';
    pin.style.cssText = 'margin:0 0 12px;padding:10px 13px;border-radius:var(--radius-sm);' +
      'background:var(--amber-dim);border-left:3px solid var(--amber);font-size:12px;line-height:1.5;';
    host.insertBefore(pin, host.firstChild);
  }
  pin.innerHTML = '<span style="font-size:9px;letter-spacing:.1em;color:var(--amber);font-weight:700;">' +
    'TODAY&#39;S ONE FIX</span><br>' + recapEsc(focus.text);
}

function recapMaybeShow() {
  try {
    const today = (typeof edToday === 'function') ? edToday() : null;
    if (!today) return;
    recapPinFocus();
    if (!recapShouldShow(today)) return;
    const day = recapLastTradedDay(today);
    if (!day) return;
    recapRender(day, today);
    const el = document.getElementById('recap-overlay');
    if (el) el.classList.add('visible');
  } catch (e) {
    console.error('Day recap failed (non-fatal):', e);
  }
}

// Delayed so the account bucket has loaded and gr_history has been hydrated from
// disk into localStorage — showing the recap before that would read an empty
// history and silently show nothing on exactly the days it matters most.
window.addEventListener('load', function () { setTimeout(recapMaybeShow, 2500); });
