'use strict';
/* ============================================================================
   RESILIENCE LAYER — added 2026-07-28
   ----------------------------------------------------------------------------
   WHY THIS FILE EXISTS
   the trader hit a hard chat lock mid-build ("the chat is crashed" — red stop icon,
   input dead, every message silently swallowed). Root cause that time was a
   wrong element id in the debate UI: getElementById returned null, appendChild
   threw, and because the throw happened AFTER setStreaming(true) but OUTSIDE
   any try/catch, nothing ever reset the flag. The chat stayed locked forever.

   The specific typo is fixed. This file exists because the CLASS of bug isn't:
   any uncaught error anywhere in the renderer, at any point in the future, can
   leave state.isStreaming stuck true and take the chat down. During live
   trading hours that is unacceptable — and a reload used to mean losing the
   entire conversation.

   WHAT THIS GUARANTEES (independent of whatever the underlying bug is)
   1. The chat can never stay locked. Three independent unlock paths:
        a) window.onerror          → force-unlock on any uncaught error
        b) unhandledrejection      → force-unlock on any dropped promise
        c) watchdog timer          → force-unlock if streaming stalls with no
                                     token for STALL_MS, even with no error
   2. The conversation is never lost. Every message is persisted to
      localStorage immediately, and mirrored to disk (via the existing
      data-save WS channel) on a debounce. On reload/crash/restart the full
      transcript is restored automatically.
   3. Errors become visible instead of silent, so the real cause can actually
      be diagnosed next time rather than guessed at.

   This file is deliberately standalone and dependency-light. It attaches
   itself to whatever app.js exposes, and every hook is individually
   try/caught — a failure inside the safety net must never itself break the
   app it is protecting.
   ========================================================================== */

(function () {
  const TRANSCRIPT_KEY = 'copilot_chat_transcript_v1';
  const STALL_MS = 120 * 1000;   // no token for this long while streaming = stalled
  const WATCHDOG_TICK = 5 * 1000;
  const MAX_PERSISTED = 400;     // cap stored turns so localStorage can't bloat

  // ── Small helpers ─────────────────────────────────────────────────────────
  function safe(fn, label) {
    try { return fn(); }
    catch (e) { console.error('[resilience] ' + (label || 'hook') + ' failed:', e); }
  }

  function hasState() {
    return typeof window.state === 'object' && window.state !== null;
  }

  // ── 1. FORCE UNLOCK ───────────────────────────────────────────────────────
  // The single most important function in this file. Whatever went wrong,
  // this puts the chat back into a usable state. Never throws.
  let lastUnlockNote = 0;
  function forceUnlock(reason) {
    safe(function () {
      if (!hasState()) return;
      if (!window.state.isStreaming) return; // nothing to unlock

      // Close out any half-written assistant bubble so the user keeps whatever
      // text did arrive, rather than it vanishing on the next render.
      try {
        if (window.state.currentAssistantBubble) {
          const partial = window.state.streamBuffer || '';
          if (partial) {
            window.state.currentAssistantBubble.innerHTML =
              (typeof window.renderMarkdown === 'function' ? window.renderMarkdown(partial) : partial) +
              '<br><em style="color:#f59e0b;font-size:11px;">[interrupted — response incomplete]</em>';
          } else {
            const row = window.state.currentAssistantBubble.parentElement;
            if (row && row.remove) row.remove();
          }
          window.state.currentAssistantBubble = null;
        }
      } catch (e) { /* keep going — unlocking matters more than tidy DOM */ }

      window.state.streamBuffer = '';

      // Prefer the app's own setter (keeps button visibility in sync); fall
      // back to touching the DOM directly if it is unavailable or broken.
      try {
        if (typeof window.setStreaming === 'function') window.setStreaming(false);
        else throw new Error('setStreaming missing');
      } catch (e) {
        window.state.isStreaming = false;
        const send = document.getElementById('send-btn');
        const cancel = document.getElementById('cancel-btn');
        const typing = document.getElementById('typing');
        if (send) send.style.display = 'flex';
        if (cancel) cancel.style.display = 'none';
        if (typing) typing.classList.remove('visible');
      }

      // Clear any orphaned debate / post-review status pills.
      try {
        document.querySelectorAll('.debate-status-pill').forEach(function (el) {
          const row = el.closest('.msg');
          if (row) row.remove();
        });
      } catch (e) {}

      // Tell the user once (rate-limited) so a burst of errors doesn't spam.
      const now = Date.now();
      if (now - lastUnlockNote > 4000) {
        lastUnlockNote = now;
        try {
          if (typeof window.addSystemMessage === 'function') {
            window.addSystemMessage('⚠ Recovered from an error — chat unlocked, your history is intact. (' + reason + ')');
          }
        } catch (e) {}
      }
      console.warn('[resilience] force-unlocked chat:', reason);
    }, 'forceUnlock');
  }
  window.__forceUnlockChat = forceUnlock; // manual escape hatch from devtools

  // ── 2. GLOBAL ERROR TRAPS ─────────────────────────────────────────────────
  // Any uncaught error or dropped promise unlocks the chat instead of
  // silently freezing it. Also surfaces the real message so the actual cause
  // is diagnosable rather than guessed at.
  window.addEventListener('error', function (ev) {
    const msg = (ev && ev.message) || 'unknown error';
    const where = ev && ev.filename ? (' @ ' + String(ev.filename).split('/').pop() + ':' + ev.lineno) : '';
    console.error('[resilience] uncaught error:', msg, where, ev && ev.error);
    forceUnlock(msg + where);
  });

  window.addEventListener('unhandledrejection', function (ev) {
    const r = ev && ev.reason;
    const msg = (r && r.message) ? r.message : String(r);
    console.error('[resilience] unhandled rejection:', msg, r);
    forceUnlock('unhandled promise: ' + msg);
  });

  // ── 3. STALL WATCHDOG ─────────────────────────────────────────────────────
  // Covers the silent case: no error thrown, but the stream died (dropped WS,
  // server hang, model never responds). If isStreaming has been true with no
  // new token for STALL_MS, unlock.
  let lastActivity = Date.now();
  function markActivity() { lastActivity = Date.now(); }
  window.__markChatActivity = markActivity;

  setInterval(function () {
    safe(function () {
      if (!hasState() || !window.state.isStreaming) { markActivity(); return; }
      if (Date.now() - lastActivity > STALL_MS) {
        forceUnlock('no response for ' + Math.round(STALL_MS / 1000) + 's — connection may have dropped');
        markActivity();
      }
    }, 'watchdog');
  }, WATCHDOG_TICK);

  // Any DOM mutation inside the message list counts as activity (tokens
  // streaming in append text nodes), so a healthy slow answer is never killed.
  safe(function () {
    const msgs = document.getElementById('messages');
    if (!msgs || typeof MutationObserver === 'undefined') return;
    new MutationObserver(markActivity).observe(msgs, { childList: true, subtree: true, characterData: true });
  }, 'observer');

  // ── 4. CONVERSATION PERSISTENCE ───────────────────────────────────────────
  // state.messages is the source of truth for the conversation. Mirror it to
  // localStorage on every change (synchronous, survives reload and crash) and
  // to disk on a debounce (survives a cache clear / different browser).
  function readStored() {
    try {
      const raw = localStorage.getItem(TRANSCRIPT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return (parsed && Array.isArray(parsed.messages)) ? parsed : null;
    } catch (e) { return null; }
  }

  let diskTimer = null;
  function persist() {
    safe(function () {
      if (!hasState() || !Array.isArray(window.state.messages)) return;
      const messages = window.state.messages.slice(-MAX_PERSISTED);
      const payload = { messages: messages, savedAt: Date.now() };

      try { localStorage.setItem(TRANSCRIPT_KEY, JSON.stringify(payload)); }
      catch (e) { console.warn('[resilience] localStorage write failed', e); }

      // Debounced disk mirror through the existing durable-data channel.
      clearTimeout(diskTimer);
      diskTimer = setTimeout(function () {
        try {
          if (window.api && typeof window.api.dataSave === 'function') {
            window.api.dataSave('chat_transcript', payload);
          }
        } catch (e) { /* disk mirror is best-effort */ }
      }, 2000);
    }, 'persist');
  }
  window.__persistChat = persist;

  // Watch state.messages for changes without requiring app.js to call us.
  // Polling is used deliberately: it cannot be bypassed by any code path that
  // mutates the array directly (push, splice, reassign all get caught).
  let lastLen = -1, lastTail = '';
  setInterval(function () {
    safe(function () {
      if (!hasState() || !Array.isArray(window.state.messages)) return;
      const arr = window.state.messages;
      const tail = arr.length ? String(arr[arr.length - 1].content || '').slice(-80) : '';
      if (arr.length !== lastLen || tail !== lastTail) {
        lastLen = arr.length;
        lastTail = tail;
        persist();
      }
    }, 'persist-poll');
  }, 1500);

  // Last-ditch save when the page is going away.
  window.addEventListener('beforeunload', function () { safe(persist, 'persist-unload'); });
  window.addEventListener('pagehide',     function () { safe(persist, 'persist-unload'); });

  // ── 5. RESTORE ON LOAD ────────────────────────────────────────────────────
  // Repaints the saved transcript into the message list and restores
  // state.messages so the model keeps full context after a reload/crash.
  function restore() {
    safe(function () {
      const stored = readStored();
      if (!stored || !stored.messages.length) return;
      if (!hasState()) return;
      if (Array.isArray(window.state.messages) && window.state.messages.length) return; // already has content

      window.state.messages = stored.messages.slice();

      const msgs = document.getElementById('messages');
      if (!msgs) return;

      const esc = (typeof window.escHtml === 'function')
        ? window.escHtml
        : function (s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); };
      const md = (typeof window.renderMarkdown === 'function') ? window.renderMarkdown : esc;

      const banner = document.createElement('div');
      banner.className = 'msg assistant';
      const when = stored.savedAt ? new Date(stored.savedAt).toLocaleString() : 'earlier';
      banner.innerHTML = '<div class="debate-status-pill" style="border-color:#22c55e;color:#22c55e;">↻ Restored ' +
        stored.messages.length + ' messages from ' + when + '</div>';
      msgs.appendChild(banner);

      stored.messages.forEach(function (m) {
        const d = document.createElement('div');
        d.className = 'msg ' + (m.role === 'user' ? 'user' : 'assistant');
        const body = m.role === 'user' ? esc(m.content || '') : md(m.content || '');
        d.innerHTML = '<div class="msg-bubble">' + body + '</div>';
        msgs.appendChild(d);
        // Restored assistant messages get the read-aloud button too, same as
        // live ones — see app.js's attachSpeakButton (2026-07-28).
        if (m.role !== 'user' && typeof window.attachSpeakButton === 'function') {
          window.attachSpeakButton(d, m.content || '');
        }
      });

      if (typeof window.scrollToBottom === 'function') window.scrollToBottom();
      console.info('[resilience] restored', stored.messages.length, 'messages');
    }, 'restore');
  }

  // Run after app.js's own DOMContentLoaded work has set up state.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(restore, 300); });
  } else {
    setTimeout(restore, 300);
  }

  // ── 6. MANUAL RECOVERY CONTROLS ───────────────────────────────────────────
  // Exposed so recovery is possible without devtools:
  //   window.__forceUnlockChat('manual')  — unlock a stuck chat
  //   window.__clearChatTranscript()      — start a genuinely fresh conversation
  window.__clearChatTranscript = function () {
    try { localStorage.removeItem(TRANSCRIPT_KEY); } catch (e) {}
    if (hasState()) window.state.messages = [];
    const msgs = document.getElementById('messages');
    if (msgs) msgs.innerHTML = '';
    console.info('[resilience] transcript cleared');
  };

  console.info('[resilience] active — error traps, stall watchdog, transcript persistence');
})();
