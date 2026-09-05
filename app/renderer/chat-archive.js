'use strict';
/* ── chat-archive.js (renderer) — capture every row the chat pane shows ──────
 * 2026-09-03. Anoop: "i want all the data that comes on the chat to be saved
 * as it comes because i want all the details to be part of the memory of the
 * app."
 *
 * The store is app/chat-archive.js — read its header for what was being lost.
 * This file is the CAPTURE side, and the only interesting decision in it is
 * where the capture happens.
 *
 * WHY A MutationObserver AND NOT 111 CALL SITES
 * --------------------------------------------
 * The chat pane is written to from everywhere: addUserMessage,
 * finalizeAssistantBubble, addSystemMessage (111 call sites on its own —
 * watcher detections, guardrail alarms, size violations, the FALLBACK notice),
 * renderTradeTicketCard, the debate/Judge/PO3/post-session renderers, the
 * shadow ticket, the self-repair notice. Instrumenting each one means "all the
 * data" is really "the data whoever edited this file last remembered to add" —
 * and the next agent surface silently isn't archived.
 *
 * Watching #messages instead makes completeness structural: if it appeared in
 * the chat, it is in the archive, whatever code put it there and whatever gets
 * added later. This is the same argument app.js's modelBadgeHtml makes for
 * putting the fallback alarm at the one point every agent renders through.
 *
 * STREAMING, AND WHY ROWS ARE RE-EMITTED
 * --------------------------------------
 * A row is not finished when it appears — an assistant bubble grows token by
 * token, and a ticket card changes when it is confirmed. So each row is
 * snapshotted once it has been QUIET for SETTLE_MS, and re-snapshotted if it
 * changes again, carrying the same id and a higher seq. The store keeps every
 * revision and folds to the newest on read.
 *
 * The row is stamped with the time it FIRST APPEARED, not the time it settled
 * or the time the outbox drained. "Saved as it comes" has to mean the archive
 * says when it came.
 *
 * THE OUTBOX EXISTS BECAUSE rawSend() SILENTLY DROPS
 * -------------------------------------------------
 * ws-client.js's rawSend no-ops when the socket is closed, and the socket
 * reconnects on a 3s timer — so a plain send would lose every message that
 * happened during a blip, invisibly. Rows therefore sit in an outbox
 * (mirrored to localStorage, so it survives a reload or a crash) and are only
 * dropped once the SERVER acknowledges they reached disk.
 *
 * Every hook is individually try/caught. This is a recorder attached to a
 * live trading tool: a failure to archive must never be able to break the
 * chat it is recording. Same doctrine as resilience.js, which this loads
 * beside.
 */

(function () {
  const OUTBOX_KEY = 'copilot_chat_archive_outbox_v1';
  const SETTLE_MS  = 900;      // quiet time before a row counts as finished
  const FORCE_MS   = 8000;     // archive a still-streaming row at least this often
  const FLUSH_MS   = 1200;     // outbox drain interval
  const BATCH_MAX  = 100;      // rows per append message (server caps at 500)
  // The outbox only fills while the server is unreachable. This ceiling stops
  // an all-day disconnect from filling localStorage; the OLDEST rows are the
  // ones dropped, and it is loud about it, because silently losing the thing
  // this file exists to save is the one failure that must not be quiet.
  const OUTBOX_MAX = 3000;

  const NBSP = String.fromCharCode(160);

  function safe(fn, label) {
    try { return fn(); }
    catch (e) { console.error('[chat-archive] ' + (label || 'hook') + ' failed:', e); }
  }

  // ── Role, from the row's own classes ──────────────────────────────────────
  // Order matters: a ticket card is BOTH .system-msg and .trade-ticket-card,
  // and "this is the trade decision" is the more useful label of the two.
  // The raw class list is archived alongside regardless, so a row whose kind
  // this does not know about is still identifiable later.
  function roleOf(el) {
    const c = el.classList;
    if (c.contains('trade-ticket-card')) return 'ticket';
    if (c.contains('user')) return 'user';
    if (c.contains('system-msg')) return 'system';
    if (c.contains('assistant')) return 'assistant';
    return 'unknown';
  }

  // ── Outbox ────────────────────────────────────────────────────────────────
  let outbox = [];
  let inFlight = null;   // { batchId, count } — rows held until the server acks

  function loadOutbox() {
    safe(function () {
      const raw = localStorage.getItem(OUTBOX_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) outbox = parsed;
    }, 'loadOutbox');
  }

  function saveOutbox() {
    safe(function () {
      if (outbox.length > OUTBOX_MAX) {
        const dropped = outbox.length - OUTBOX_MAX;
        outbox = outbox.slice(-OUTBOX_MAX);
        console.error('[chat-archive] outbox full — DROPPED ' + dropped +
          ' unsaved chat rows. The server has been unreachable; those rows are lost.');
      }
      localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox));
    }, 'saveOutbox');
  }

  function enqueue(row) {
    outbox.push(row);
    saveOutbox();
  }

  function flush() {
    safe(function () {
      if (inFlight || !outbox.length) return;
      if (!window.api || typeof window.api.chatArchiveAppend !== 'function') return;
      const batch = outbox.slice(0, BATCH_MAX);
      const batchId = 'b-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const sent = window.api.chatArchiveAppend(batch, batchId);
      // false = socket down. Keep everything and try again on the next tick
      // or on ws:open, rather than treating "handed to a dead socket" as sent.
      if (sent) inFlight = { batchId: batchId, count: batch.length };
    }, 'flush');
  }

  function onAck(msg) {
    safe(function () {
      if (!inFlight || (msg.batchId && msg.batchId !== inFlight.batchId)) return;
      if (msg.ok) {
        outbox = outbox.slice(inFlight.count);
        saveOutbox();
        inFlight = null;
        if (outbox.length) flush();   // keep draining a backlog promptly
      } else {
        // A disk-side failure. Keep the rows and let the interval retry —
        // NOT an immediate re-flush, which against a permanently broken disk
        // would spin as fast as the round-trip allows.
        console.error('[chat-archive] server failed to save a batch:', msg.error);
        inFlight = null;
      }
    }, 'onAck');
  }

  // ── Capture ───────────────────────────────────────────────────────────────
  let idCounter = 0;
  const timers = new WeakMap();   // row element -> settle timer
  const lastSig = new WeakMap();  // row element -> last archived content signature
  const seqOf = new WeakMap();    // row element -> revision counter
  const lastSnapAt = new WeakMap(); // row element -> when it was last archived

  // Walk up to the top-level chat row (a direct child of #messages).
  function rowFor(node, msgs) {
    let el = (node && node.nodeType === 1) ? node : (node && node.parentElement);
    while (el && el.parentElement && el.parentElement !== msgs) el = el.parentElement;
    return (el && el.parentElement === msgs) ? el : null;
  }

  // Read the row's content. Prefer .msg-bubble over the row itself: the
  // read-aloud button app.js attaches lives on the ROW, not the bubble, so
  // taking the row would archive a speaker glyph as part of every reply.
  // Rows with no bubble (debate status pills) fall back to the row.
  function textOf(el) {
    let src = '';
    const bubbles = el.querySelectorAll('.msg-bubble');
    if (bubbles.length) {
      const parts = Array.prototype.map.call(bubbles, function (b) { return b.innerText || ''; });
      src = parts.join('\n');
    } else {
      src = el.innerText || '';
    }
    return src.split(NBSP).join(' ').replace(/[ \t]+\n/g, '\n').trim();
  }

  // A trade ticket card carries its numbers in <input> VALUES, which are not
  // text and would otherwise be archived as an empty form — losing the one
  // detail that matters most about a GO decision: the size he was about to
  // send. Captured as structured meta rather than folded into the text.
  function fieldsOf(el) {
    const inputs = el.querySelectorAll('input, select');
    if (!inputs.length) return null;
    const out = {};
    Array.prototype.forEach.call(inputs, function (i) {
      const key = i.id || i.name || i.className || 'field';
      if (i.value !== '' && i.value != null) out[key] = i.value;
    });
    return Object.keys(out).length ? out : null;
  }

  function snapshot(el) {
    safe(function () {
      if (!el.isConnected) return;
      const text = textOf(el);
      const fields = fieldsOf(el);
      if (!text && !fields) return;
      const sig = text + ' | ' + (fields ? JSON.stringify(fields) : '');
      if (lastSig.get(el) === sig) return;   // settled to the same content
      lastSig.set(el, sig);
      const seq = seqOf.get(el) || 0;
      seqOf.set(el, seq + 1);
      const row = {
        id: el.dataset.archId,
        seq: seq,
        role: roleOf(el),
        classes: el.className || '',
        text: text,
        clientTs: Number(el.dataset.archTs) || Date.now()
      };
      if (fields) row.meta = { fields: fields };
      enqueue(row);
    }, 'snapshot');
  }

  function touch(el) {
    if (!el || el.nodeType !== 1 || !el.dataset) return;
    // Rows repainted from a saved transcript are not new speech — see the
    // data-replay comment in resilience.js's restore(). Without this, every
    // reload would append the whole conversation again under fresh ids.
    if (el.dataset.replay === '1') return;
    const now = Date.now();
    if (!el.dataset.archId) {
      el.dataset.archId = 'r-' + now + '-' + (++idCounter);
      el.dataset.archTs = String(now);
      lastSnapAt.set(el, now);
    }
    // A long reply streams continuously, so the settle timer keeps getting
    // pushed out and nothing would reach disk until the model stopped talking
    // — a browser crash mid-answer would lose the whole thing. Force a
    // revision every FORCE_MS so a partial is always on disk. Revisions fold
    // on read, so the interim rows cost nothing to a reader.
    if (now - (lastSnapAt.get(el) || now) >= FORCE_MS) {
      lastSnapAt.set(el, now);
      snapshot(el);
    }
    clearTimeout(timers.get(el));
    timers.set(el, setTimeout(function () { lastSnapAt.set(el, Date.now()); snapshot(el); }, SETTLE_MS));
  }

  // Force every pending row out now — used when the page is going away, where
  // waiting out SETTLE_MS would mean losing the last thing said.
  function settleAll() {
    safe(function () {
      const msgs = document.getElementById('messages');
      if (!msgs) return;
      Array.prototype.forEach.call(msgs.children, function (el) {
        if (el.dataset && el.dataset.archId) { clearTimeout(timers.get(el)); snapshot(el); }
      });
    }, 'settleAll');
  }

  function start() {
    const msgs = document.getElementById('messages');
    if (!msgs || typeof MutationObserver === 'undefined') {
      console.warn('[chat-archive] no #messages element — capture NOT active');
      return;
    }

    // Anything already on screen at startup (rendered before this observer
    // attached) still gets archived, minus replayed rows.
    Array.prototype.forEach.call(msgs.children, touch);

    new MutationObserver(function (records) {
      safe(function () {
        for (const rec of records) {
          if (rec.addedNodes && rec.addedNodes.length) {
            for (const n of rec.addedNodes) {
              const row = rowFor(n, msgs);
              if (row) touch(row);
            }
          }
          // Character/child churn inside an existing row: a stream arriving, a
          // ticket card being confirmed, a bubble rewritten by resilience.js's
          // forceUnlock. All of it re-arms that row's settle timer.
          const row = rowFor(rec.target, msgs);
          if (row) touch(row);
        }
      }, 'observer');
    }).observe(msgs, { childList: true, subtree: true, characterData: true });

    setInterval(flush, FLUSH_MS);
    window.addEventListener('beforeunload', function () { settleAll(); flush(); });
    window.addEventListener('pagehide',     function () { settleAll(); flush(); });

    safe(function () {
      if (window.api && window.api.onChatArchiveAppended) window.api.onChatArchiveAppended(onAck);
      // A reconnect is the moment a backlog can finally move. inFlight is
      // cleared first: a batch sent just before the socket died will never be
      // acked, and holding it would wedge the queue forever.
      if (window.api && window.api.onWsOpen) window.api.onWsOpen(function () { inFlight = null; flush(); });
    }, 'wire');

    console.info('[chat-archive] capture active — every chat row is archived to DATA/chat_archive/');
  }

  // ── Manual controls (no devtools archaeology required) ────────────────────
  //   window.__chatArchiveStatus()            — what is on disk, what is pending
  //   window.__chatArchiveSearch('revenge')   — grep the whole archive
  //   window.__chatArchiveDay('2026-09-03')   — one trading day, in full
  //   window.__chatArchiveFlush()             — settle + send everything now
  window.__chatArchiveStatus = function () {
    const pending = outbox.length;
    const q = (window.api && window.api.chatArchiveQuery)
      ? window.api.chatArchiveQuery({ scope: 'stats' })
      : Promise.resolve(null);
    return q.then(function (s) {
      const out = { onDisk: s, pendingUnsaved: pending, inFlight: inFlight };
      console.info('[chat-archive]', out);
      return out;
    });
  };
  window.__chatArchiveSearch = function (query, limit) {
    return window.api.chatArchiveQuery({ scope: 'search', query: query, limit: limit || 20 })
      .then(function (rows) {
        console.table((rows || []).map(function (r) {
          return { day: r.tradingDay, time: r.istTime, role: r.role, text: String(r.text).slice(0, 120) };
        }));
        return rows;
      });
  };
  window.__chatArchiveDay = function (day) {
    return window.api.chatArchiveQuery({ scope: 'day', day: day });
  };
  window.__chatArchiveFlush = function () { settleAll(); flush(); return outbox.length; };

  loadOutbox();
  // After resilience.js's restore() (300ms), so replayed rows are already
  // tagged and on the page before the initial sweep looks at them.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 400); });
  } else {
    setTimeout(start, 400);
  }
})();
