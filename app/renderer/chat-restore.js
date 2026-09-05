'use strict';
/* ── chat-restore.js (renderer) — repaint the pane from the ARCHIVE ──────────
 * 2026-09-04. Anoop: "i do not see yesterdays deepseeks responds in the chat.
 * i said i wanted everything in the chat to be saved in the memory and Loop
 * should take part."
 *
 * He was right about the symptom and the data was never the problem. On
 * 2026-09-03 the archive captured 413 rows — 21 from him, 84 assistant
 * replies, 307 app/system rows and 1 trade ticket — and every one of them is
 * still on disk in DATA/chat_archive/2026-09-03.jsonl. Nothing was lost.
 * What was missing is that NOTHING PAINTED IT BACK.
 *
 * WHY THE PANE LOOKED EMPTY
 * -------------------------
 * The only restore that existed was resilience.js's, and it repaints
 * `state.messages` — a different store with two properties that make it the
 * wrong source for the visible pane:
 *
 *   1. app.js:5979 trims it to the last 40 turns, because that array is the
 *      MODEL CONTEXT and a bigger one costs tokens on every request. Correct
 *      for context; fatal as a history. Yesterday's 84 replies do not fit in
 *      40 turns, so the oldest were gone before the page ever reloaded.
 *   2. It only ever holds user and assistant chat turns. The 307 system rows
 *      — every watcher detection, guardrail alarm, size violation, fallback
 *      notice — and THE LOOP's own output were never in it at all.
 *
 * So the archive was the complete record and the pane was showing a lossy
 * 40-turn extract of a subset of it. This file makes the pane read from the
 * record instead.
 *
 * THE PANE AND THE CONTEXT ARE DELIBERATELY DIFFERENT SIZES
 * --------------------------------------------------------
 * This does NOT feed restored rows back into `state.messages`. resilience.js
 * still owns that, still restores 40 turns, and the model still gets 20 of
 * them per request. Widening what he can SEE must not widen what every
 * request PAYS FOR — that is the same argument recall_chat makes in
 * server.js: recall is a lookup, not a bigger context window. If he wants an
 * older exchange in front of the model, the agents reach it through
 * recall_chat, which searches the whole archive on demand.
 *
 * WHY IT RESERVES THE PANE SYNCHRONOUSLY
 * --------------------------------------
 * resilience.js repaints at DOMContentLoaded + 300ms, synchronously from
 * localStorage. This restore needs a WebSocket round-trip, so it can never
 * win that race on timing. Instead it plants a flag the moment the script
 * parses (this file loads BEFORE resilience.js in index.html) and
 * resilience.js skips only its DOM repaint while the flag is set — never its
 * state.messages restore, which is unrelated and must always run.
 *
 * If the archive query fails or comes back empty, this calls
 * window.__resilienceRepaint() to hand the pane back. An archive problem must
 * leave him with the old 40-turn view, never with a blank chat.
 *
 * EVERY ROW IS data-replay="1"
 * ----------------------------
 * Same contract resilience.js's restore uses: renderer/chat-archive.js's
 * touch() returns early on those rows. Without it, opening the app would
 * append the entire history to the archive again under fresh ids, and every
 * reload would double the record this file exists to show.
 * ========================================================================== */

(function () {
  // Claim the pane before resilience.js's timer fires. See the header.
  window.__chatArchiveRestorePending = true;

  const DEFAULT_LIMIT = 300;    // rows painted on open
  const MORE_STEP     = 300;    // rows added per "load more"
  const MAX_LIMIT     = 5000;   // ceiling on one repaint — the store is unbounded
  const WRAP_ID       = 'chat-restore-block';

  // Roles painted. null = everything, which is the default because he asked
  // for "all the data that comes on the chat". But on a live trading day the
  // watchers dominate the record — the last 300 rows are 246 system rows to
  // 52 replies — so finding what an agent actually SAID means scrolling past
  // eight watcher pings per answer. The toggle narrows the view; it never
  // narrows the archive, which keeps every row regardless.
  const CONVO_ROLES = ['user', 'assistant', 'ticket'];
  let convoOnly = false;

  let currentLimit = DEFAULT_LIMIT;
  let painting = false;

  function safe(fn, label) {
    try { return fn(); }
    catch (e) { console.error('[chat-restore] ' + (label || 'hook') + ' failed:', e); }
  }

  function esc(s) {
    if (typeof window.escHtml === 'function') return window.escHtml(s);
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }

  function md(s) {
    return (typeof window.renderMarkdown === 'function') ? window.renderMarkdown(s || '') : esc(s);
  }

  // Classes that must never come back. A restored trade ticket wearing
  // .trade-ticket-card would look like a live card whose Confirm control is
  // gone, and on a path that can place a real order a dead confirm button is
  // worse than a plain row. The rest are transient stream states that only
  // mean anything while a row is being written.
  const DROP_CLASSES = ['trade-ticket-card', 'streaming', 'pending', 'typing'];

  // Everything else on the archived row is KEPT. The important case is
  // .loop-feedback: THE LOOP fired 19 times on 2026-09-03 and every one of
  // its answers is in the archive, but with only a role->class map they would
  // all come back as anonymous assistant bubbles — the agent whose whole job
  // is "I have told you this before" would be indistinguishable from ordinary
  // chat in the history it is supposed to be held to. Keeping the archived
  // classes also means a marker class added later is preserved without anyone
  // remembering to update this file, which is the same structural-completeness
  // argument renderer/chat-archive.js makes for watching #messages.
  function classFor(r) {
    const base = r.role === 'user' ? 'user'
      : r.role === 'assistant' ? 'assistant'
      : 'system-msg';
    const kept = String(r.classes || '')
      .split(/\s+/)
      .filter(function (c) { return c && c !== 'msg' && DROP_CLASSES.indexOf(c) === -1; });
    if (kept.indexOf(base) === -1) kept.unshift(base);
    return 'msg ' + kept.join(' ');
  }

  function dayLabel(day) {
    try {
      const d = new Date(day + 'T12:00:00');
      return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' }) + ' — ' + day;
    } catch (e) { return day; }
  }

  function separator(day) {
    const el = document.createElement('div');
    el.className = 'msg system-msg';
    el.dataset.replay = '1';
    el.innerHTML = '<div class="debate-status-pill" style="border-color:#475569;color:#94a3b8;">'
      + esc(dayLabel(day)) + '</div>';
    return el;
  }

  function rowEl(r) {
    const el = document.createElement('div');
    el.className = classFor(r);
    el.dataset.replay = '1';
    const stamp = '<div style="font-size:10px;opacity:.45;margin-bottom:3px;">'
      + esc(r.istTime || '') + ' IST'
      + (r.role === 'ticket' ? ' · TRADE TICKET' : '')
      + '</div>';
    const body = (r.role === 'user') ? esc(r.text || '') : md(r.text || '');
    el.innerHTML = '<div class="msg-bubble">' + stamp + body + '</div>';
    if (r.role !== 'user' && typeof window.attachSpeakButton === 'function') {
      safe(function () { window.attachSpeakButton(el, r.text || ''); }, 'speak-button');
    }
    return el;
  }

  function banner(rows, truncated) {
    const el = document.createElement('div');
    el.className = 'msg system-msg';
    el.dataset.replay = '1';
    const first = rows.length ? rows[0].tradingDay : '';
    const last  = rows.length ? rows[rows.length - 1].tradingDay : '';
    const span  = (first && last && first !== last) ? (first + ' → ' + last) : (last || 'the archive');
    const btn = 'font-size:11px;padding:3px 10px;margin:0 3px;cursor:pointer;background:transparent;'
      + 'border:1px solid #475569;border-radius:10px;color:#94a3b8;';
    let html = '<div class="debate-status-pill" style="border-color:#22c55e;color:#22c55e;">↻ '
      + rows.length + ' rows restored from the chat archive · ' + esc(span)
      + (convoOnly ? ' · conversation only' : '') + '</div>'
      + '<div style="margin-top:6px;text-align:center;">'
      + '<button type="button" id="chat-restore-convo" style="' + btn + '">'
      + (convoOnly ? 'show everything' : 'conversation only') + '</button>'
      + (truncated
        ? '<button type="button" id="chat-restore-more" style="' + btn + '">load ' + MORE_STEP + ' more</button>'
        : '')
      + '</div>';
    el.innerHTML = html;
    return el;
  }

  // ── Paint ─────────────────────────────────────────────────────────────────
  // Restored rows go ABOVE whatever is already in the pane: by the time the
  // round-trip lands, the server has usually already pushed live system rows
  // (connection state, watcher status) and those belong at the bottom where
  // they arrived.
  function paint(rows, truncated) {
    const msgs = document.getElementById('messages');
    if (!msgs) return;

    const old = document.getElementById(WRAP_ID);
    if (old) old.remove();

    const holder = document.createElement('div');
    holder.id = WRAP_ID;
    holder.dataset.replay = '1';
    // display:contents keeps each row a LAYOUT child of #messages, so the
    // flex rules in styles.css (.msg.system-msg { align-self: center }) still
    // apply. The wrapper exists only so "load more" can replace the whole
    // block in one call.
    holder.style.display = 'contents';

    holder.appendChild(banner(rows, truncated));
    let lastDay = null;
    rows.forEach(function (r) {
      if (r.tradingDay && r.tradingDay !== lastDay) {
        lastDay = r.tradingDay;
        holder.appendChild(separator(r.tradingDay));
      }
      holder.appendChild(rowEl(r));
    });

    msgs.insertBefore(holder, msgs.firstChild);

    const more = document.getElementById('chat-restore-more');
    if (more) more.addEventListener('click', function () {
      more.disabled = true;
      more.textContent = 'loading…';
      currentLimit = Math.min(MAX_LIMIT, currentLimit + MORE_STEP);
      load({ keepScroll: true });
    });

    const convo = document.getElementById('chat-restore-convo');
    if (convo) convo.addEventListener('click', function () {
      convo.disabled = true;
      convoOnly = !convoOnly;
      load({ keepScroll: true });
    });

    console.info('[chat-restore] painted', rows.length, 'archived rows');
  }

  // ── Load ──────────────────────────────────────────────────────────────────
  function load(opts) {
    const keepScroll = !!(opts && opts.keepScroll);
    if (painting) return Promise.resolve();
    painting = true;
    return safe(function () {
      if (!window.api || typeof window.api.chatArchiveQuery !== 'function') {
        painting = false;
        return handoff('no chatArchiveQuery on window.api');
      }
      const q = { scope: 'recent', limit: currentLimit };
      if (convoOnly) q.roles = CONVO_ROLES;
      return window.api.chatArchiveQuery(q)
        .then(function (msg) {
          painting = false;
          if (msg && msg.error) return handoff('server: ' + msg.error);
          const rows = (msg && Array.isArray(msg.data)) ? msg.data : [];
          if (!rows.length) return handoff('archive is empty');
          window.__chatArchiveRestorePending = false;
          const msgs = document.getElementById('messages');
          const atBottom = msgs
            ? (msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight) < 120
            : true;
          paint(rows, rows.length >= currentLimit && currentLimit < MAX_LIMIT);
          if (!keepScroll && atBottom && typeof window.scrollToBottom === 'function') {
            window.scrollToBottom();
          }
        })
        .catch(function (e) {
          painting = false;
          handoff('query failed: ' + (e && e.message));
        });
    }, 'load');
  }

  // The archive could not answer. Give the pane back to resilience.js rather
  // than leaving him staring at a blank chat — a degraded 40-turn view is a
  // far better failure than no history at all.
  function handoff(why) {
    console.warn('[chat-restore] falling back to the saved transcript —', why);
    window.__chatArchiveRestorePending = false;
    safe(function () {
      if (typeof window.__resilienceRepaint === 'function') window.__resilienceRepaint();
    }, 'handoff');
  }

  // ── Start ─────────────────────────────────────────────────────────────────
  // The query needs an open socket. ws-client reconnects on a 3s timer, so a
  // load that starts before the socket is up would fail on a cold start —
  // wait for ws:open, with a timeout that hands off rather than hanging.
  function start() {
    let fired = false;
    function go() {
      if (fired) return;
      fired = true;
      load({});
    }
    safe(function () {
      if (window.api && typeof window.api.onWsOpen === 'function') window.api.onWsOpen(go);
    }, 'wire-ws-open');
    // Already-connected case (ws:open fired before this listener attached),
    // and the give-up path if the socket never comes.
    setTimeout(function () {
      if (window.api && typeof window.api.chatArchiveQuery === 'function') go();
    }, 1200);
    setTimeout(function () {
      if (!fired) { fired = true; handoff('socket never opened'); }
    }, 12000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // Manual control, no devtools archaeology required:
  //   window.__chatRestore(800)  — repaint the pane with 800 archived rows
  window.__chatRestore = function (limit) {
    currentLimit = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT));
    return load({});
  };

  console.info('[chat-restore] active — the chat pane reads from DATA/chat_archive/');
})();
