'use strict';
// WebSocket client — replaces Electron IPC (window.api)
(function () {
  const PORT = 7433;
  let ws = null;
  let reqCounter = 0;
  const pending = new Map();   // reqId → {resolve, reject}
  const listeners = {};        // eventName → [callbacks]
  let cachedConfig = null;
  let currentReqId = null;     // active chat request (for cancel)
  let currentJessiReqId = null; // active Jessi (Groq) chat request
  let currentJessiVoiceReqId = null; // active Jessi voice-mode request
  let currentDebateReqId = null;     // active 3-agent debate request
  let currentAutoDebateReqId = null; // active PO3-monitor-triggered debate (independent of the above — see 'auto-debate-triggered')
  let currentScalperReqId = null;    // active Scalper (scalping specialist) request
  let currentPostReviewReqId = null; // active post-session review request
  let currentPo3ReqId = null;        // active ICT Power of 3 request

  // ── Event bus ───────────────────────────────────────────────────────────────
  function on(type, cb) {
    if (!listeners[type]) listeners[type] = [];
    listeners[type].push(cb);
    return () => { listeners[type] = listeners[type].filter(f => f !== cb); };
  }

  function off(type, cb) {
    if (listeners[type]) listeners[type] = listeners[type].filter(f => f !== cb);
  }

  function emit(type, ...args) {
    (listeners[type] || []).slice().forEach(cb => cb(...args));
  }

  // ── WS connection ───────────────────────────────────────────────────────────
  function connect() {
    ws = new WebSocket(`ws://localhost:${PORT}`);

    ws.onopen = () => emit('ws:open');

    ws.onclose = () => {
      emit('mcp:disconnected');
      setTimeout(connect, 3000);
    };

    ws.onerror = () => {};

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleServerMsg(msg);
    };
  }

  function handleServerMsg(msg) {
    switch (msg.type) {

      // Lifetime view (2026-08-31): merged record across every slot +
      // archived account. Read-only; applied to an in-memory overlay only.
      case 'exit-mark-result':
        try { if (typeof renderExitMarkResult === 'function') renderExitMarkResult(msg); }
        catch (e) { console.warn('[exit-mark] render failed:', e.message); }
        break;
      case 'exit-drift-data':
        try { if (typeof renderExitDrift === 'function') renderExitDrift(msg); }
        catch (e) { console.warn('[exit-drift] render failed:', e.message); }
        break;
      case 'lifetime-data':
        try { if (typeof lifetimeApply === 'function') lifetimeApply(msg.error ? { error: msg.error } : msg.data); }
        catch (e) { console.warn('[lifetime] apply failed:', e.message); }
        break;
      case 'config':
        cachedConfig = msg.data || {};
        emit('config:data', cachedConfig);
        break;

      case 'config-saved':
        emit('config:saved:' + msg.key, msg);
        break;

      case 'mcp-status':
        window._mcpConnected = msg.connected;
        msg.connected ? emit('mcp:connected') : emit('mcp:disconnected');
        if (msg.message) emit('mcp:status', msg.message);
        break;

      case 'mcp-status-msg':
        emit('mcp:status', msg.message);
        break;

      case 'mcp-result':
        resolvePending(msg.reqId, msg);
        break;

      case 'tts-result':
        resolvePending(msg.reqId, msg);
        break;

      case 'tts-diagnose-result':
        resolvePending(msg.reqId, msg);
        break;

      // ── Chat streaming events ─────────────────────────────────────────────
      case 'chat-token':
        if (msg.reqId === currentReqId) emit('chat:token', msg.text);
        break;

      case 'chat-tool-start':
        if (msg.reqId === currentReqId) emit('chat:toolStart', msg.name, msg.id);
        break;

      case 'chat-tool-done':
        if (msg.reqId === currentReqId) emit('chat:toolDone', msg.name, msg.id, msg.ok, msg.result);
        break;

      case 'chat-done':
        if (msg.reqId === currentReqId) {
          currentReqId = null;
          emit('chat:done', msg.fullText);
        }
        break;

      case 'chat-error':
        if (msg.reqId === currentReqId) {
          currentReqId = null;
          emit('chat:error', msg.message);
        }
        break;

      // 2026-08-16 (Pattern 02, assistive routing): advisory only — not
      // gated on currentJessiReqId since it's informational, not part of the
      // streamed answer, and should still show even if a newer message has
      // already superseded reqId tracking by the time it arrives.
      case 'mode-hint':
        emit('jessiChat:modeHint', msg.message);
        break;

      case 'jessi-chat-token':
        if (msg.reqId === currentJessiReqId) emit('jessiChat:token', msg.text);
        break;

      case 'jessi-chat-tool-start':
        if (msg.reqId === currentJessiReqId) emit('jessiChat:toolStart', msg.name, msg.id);
        break;

      case 'jessi-chat-tool-done':
        if (msg.reqId === currentJessiReqId) emit('jessiChat:toolDone', msg.name, msg.id, msg.ok, msg.result);
        break;

      case 'jessi-chat-fallback':
        if (msg.reqId === currentJessiReqId) emit('jessiChat:fallback', msg.from, msg.to);
        break;

      case 'jessi-chat-quota-warn':
        if (msg.reqId === currentJessiReqId) emit('jessiChat:quotaWarn', msg.message);
        break;

      case 'jessi-chat-done':
        if (msg.reqId === currentJessiReqId) {
          currentJessiReqId = null;
          emit('jessiChat:done', msg.fullText, msg.answeredBy);
        }
        break;

      case 'jessi-chat-error':
        if (msg.reqId === currentJessiReqId) {
          currentJessiReqId = null;
          emit('jessiChat:error', msg.message);
        }
        break;

      // ── The Scalper (scalping specialist, 2026-08-01) ────────────────────
      case 'scalper-token':
        if (msg.reqId === currentScalperReqId) emit('scalper:token', msg.text);
        break;

      case 'scalper-tool':
        if (msg.reqId === currentScalperReqId) {
          emit(msg.phase === 'start' ? 'scalper:toolStart' : 'scalper:toolDone', msg.name);
        }
        break;

      case 'scalper-fallback':
        if (msg.reqId === currentScalperReqId) emit('scalper:fallback', msg.from, msg.to);
        break;

      case 'scalper-done':
        if (msg.reqId === currentScalperReqId) {
          currentScalperReqId = null;
          emit('scalper:done', msg.fullText, msg.answeredBy);
        }
        break;

      case 'scalper-error':
        if (msg.reqId === currentScalperReqId) {
          currentScalperReqId = null;
          emit('scalper:error', msg.message);
        }
        break;

      // ── 3-Agent Debate mode ──────────────────────────────────────────────
      // 2026-08-17: every debate-* message now also checks currentAutoDebateReqId
      // (set on 'auto-debate-triggered' below) — without this, a PO3-monitor-
      // triggered debate's status/arguments/verdict would be silently dropped
      // here (reqId never matches currentDebateReqId, which only a manual
      // sendDebateChat() call ever sets), even though the server broadcasts
      // them correctly. Routed to a parallel debate:auto* channel so it can't
      // collide with a manual debate's own UI rendering.
      case 'debate-status':
        if (msg.reqId === currentDebateReqId) emit('debate:status', msg.phase);
        else if (msg.reqId === currentAutoDebateReqId) emit('debate:autoStatus', msg.phase);
        break;
      case 'debate-arguments':
        if (msg.reqId === currentDebateReqId) {
          emit('debate:arguments', msg.jessi, msg.analysis, msg.po3,
            { jessi: msg.jessiAnsweredBy, analysis: msg.analysisAnsweredBy, po3: msg.po3AnsweredBy });
        } else if (msg.reqId === currentAutoDebateReqId) {
          emit('debate:autoArguments', msg.jessi, msg.analysis, msg.po3,
            { jessi: msg.jessiAnsweredBy, analysis: msg.analysisAnsweredBy, po3: msg.po3AnsweredBy });
        }
        break;
      case 'debate-judge-token':
        if (msg.reqId === currentDebateReqId) emit('debate:judgeToken', msg.text);
        else if (msg.reqId === currentAutoDebateReqId) emit('debate:autoJudgeToken', msg.text);
        break;
      case 'debate-judge-done':
        if (msg.reqId === currentDebateReqId) {
          currentDebateReqId = null;
          emit('debate:judgeDone', msg.fullText, msg.answeredBy);
        } else if (msg.reqId === currentAutoDebateReqId) {
          currentAutoDebateReqId = null;
          emit('debate:autoJudgeDone', msg.fullText, msg.answeredBy);
        }
        break;
      case 'debate-judge-error':
        if (msg.reqId === currentDebateReqId) {
          currentDebateReqId = null;
          emit('debate:judgeError', msg.message);
        } else if (msg.reqId === currentAutoDebateReqId) {
          currentAutoDebateReqId = null;
          emit('debate:autoJudgeError', msg.message);
        }
        break;
      // 2026-08-16 (Pattern 03 voting variant): arrives AFTER debate-judge-done
      // already nulled currentDebateReqId, so — like mode-hint — this is
      // deliberately ungated on reqId. Silent (no message) when the refuter
      // found nothing, so this only ever fires with something worth reading.
      case 'debate-refutation':
        emit('debate:refutation', msg.text);
        break;

      // 2026-08-17: PO3 monitor auto-triggered a Debate call on its own
      // (left ACCUMULATION) — not gated on currentDebateReqId since nothing
      // client-side initiated this one. Adopting msg.reqId here is what lets
      // the debate-* cases above route this specific run's events to the
      // debate:auto* channel instead of dropping them.
      case 'auto-debate-triggered':
        currentAutoDebateReqId = msg.reqId;
        emit('debate:autoTriggered', msg);
        break;

      // ── Phase 2b: trade confirm/execute (2026-08-17) ─────────────────────
      // Arrives after debate-judge-done (same as debate-refutation above),
      // ungated on reqId for the same reason — currentDebateReqId is already
      // nulled by then.
      case 'trade-ticket-suggested':
        emit('trade:ticketSuggested', msg);
        break;
      case 'trade-confirm-result':
        emit('trade:confirmResult', msg);
        break;
      case 'trade-confirm-rejected':
        emit('trade:confirmRejected', msg);
        break;

      // 2026-08-23: the server has broadcast this since 2026-08-20 and NOTHING
      // listened, so a trade row the auto-log refused to write reported into
      // the void — the exact silent-failure mode that logTrade's own honest
      // return value was added to prevent. Reachable more often since 7.0 made
      // writeAtomic failures report too (an Obsidian/Defender handle on the .md
      // is now normal, because the vault root is the repo).
      case 'session-log-failed':
        emit('session:logFailed', msg);
        break;

      // ── Post-Session Analyst ─────────────────────────────────────────────
      case 'post-review-status':
        if (msg.reqId === currentPostReviewReqId) emit('postReview:status', msg.phase);
        break;
      case 'post-review-token':
        if (msg.reqId === currentPostReviewReqId) emit('postReview:token', msg.text);
        break;
      case 'post-review-done':
        if (msg.reqId === currentPostReviewReqId) {
          currentPostReviewReqId = null;
          emit('postReview:done', msg.fullText, msg.answeredBy);
        }
        break;
      case 'post-review-error':
        if (msg.reqId === currentPostReviewReqId) {
          currentPostReviewReqId = null;
          emit('postReview:error', msg.message);
        }
        break;

      // ── Power of 3 phase monitor (mechanical, 60s) ───────────────────────
      case 'po3-phase-change':   emit('po3:phaseChange', msg);   break;
      case 'po3-monitor-status': emit('po3:monitorStatus', msg); break;
      case 'po3-monitor-check':  emit('po3:monitorCheck', msg);  break;

      // ── ICT Power of 3 (AMD phase) ───────────────────────────────────────
      case 'po3-status':
        if (msg.reqId === currentPo3ReqId) emit('po3:status', msg.phase);
        break;
      case 'po3-token':
        if (msg.reqId === currentPo3ReqId) emit('po3:token', msg.text);
        break;
      case 'po3-done':
        if (msg.reqId === currentPo3ReqId) { currentPo3ReqId = null; emit('po3:done', msg.fullText, msg.answeredBy); }
        break;
      case 'po3-error':
        if (msg.reqId === currentPo3ReqId) { currentPo3ReqId = null; emit('po3:error', msg.message); }
        break;

      // ── Jessi voice mode (voice in, voice out) ────────────────────────────
      case 'jessi-voice-transcript':
        if (msg.reqId === currentJessiVoiceReqId) emit('jessiVoice:transcript', msg.text);
        break;

      case 'jessi-voice-tool-start':
        if (msg.reqId === currentJessiVoiceReqId) emit('jessiVoice:toolStart', msg.name, msg.id);
        break;

      case 'jessi-voice-tool-done':
        if (msg.reqId === currentJessiVoiceReqId) emit('jessiVoice:toolDone', msg.name, msg.id, msg.ok, msg.result);
        break;

      case 'jessi-voice-fallback':
        if (msg.reqId === currentJessiVoiceReqId) emit('jessiVoice:fallback', msg.from, msg.to);
        break;

      case 'jessi-voice-quota-warn':
        if (msg.reqId === currentJessiVoiceReqId) emit('jessiVoice:quotaWarn', msg.message);
        break;

      case 'jessi-voice-audio':
        if (msg.reqId === currentJessiVoiceReqId) {
          currentJessiVoiceReqId = null;
          emit('jessiVoice:audio', msg.fullText, msg.clips, msg.mime, msg.answeredBy);
        }
        break;

      case 'jessi-voice-error':
        if (msg.reqId === currentJessiVoiceReqId) {
          currentJessiVoiceReqId = null;
          emit('jessiVoice:error', msg.message);
        }
        break;

      // ── Jessi app-action bridge: server asks the client to run a UI action
      // (switch tab, refresh, mark levels, journal, etc.) and awaits the
      // result. window.jessiExecuteAppAction lives in app.js. ──────────────
      case 'jessi-app-action': {
        const run = window.jessiExecuteAppAction
          ? window.jessiExecuteAppAction(msg.action, msg.args || {})
          : Promise.resolve({ ok: false, result: 'App action handler not loaded.' });
        Promise.resolve(run).then(r => {
          const res = (r && typeof r === 'object') ? r : { ok: true, result: String(r) };
          rawSend({ type: 'jessi-app-action-result', actionId: msg.actionId, ok: res.ok !== false, result: res.result });
        }).catch(e => {
          rawSend({ type: 'jessi-app-action-result', actionId: msg.actionId, ok: false, result: 'Error: ' + e.message });
        });
        break;
      }

      // ── Mode & engulf ─────────────────────────────────────────────────────
      case 'mode-update':
        emit('mode:update', msg.mode);
        break;

      // ── Oversize guard (2026-09-02) ──────────────────────────────────────
      // The server had been broadcasting 'oversize-guard' evidence since
      // 2026-08-28 and NOTHING here listened, so the only surface for the one
      // guard that can act on the account unasked was a console line in a
      // window Anoop never has open. That is why a real 5-lot came and went
      // with no visible trace.
      case 'oversize-guard':
        emit('oversize:event', msg);
        break;

      case 'oversize-guard-status':
        emit('oversize:status', msg);
        break;

      // T1.1 per-trade max-loss tripwire (2026-09-04) — loud on purpose, like the
      // oversize guard. A blind (P&L unreadable) or breach event must shout.
      case 'per-trade-stop':
        emit('pertradestop:event', msg);
        break;

      case 'engulf-monitor-status':
        emit('engulf:monitorStatus', msg);
        break;

      case 'engulf-signal':
        emit('engulf:signal', msg);
        break;

      case 'engulf-check':
        emit('engulf:check', msg);
        break;

      case 'fvg-monitor-status':
        emit('fvg:monitorStatus', msg);
        break;

      case 'fvg-signal':
        emit('fvg:signal', msg);
        break;

      case 'fvg-check':
        emit('fvg:check', msg);
        break;

      case 'sfp-monitor-status':
        emit('sfp:monitorStatus', msg);
        break;

      case 'sfp-signal':
        emit('sfp:signal', msg);
        break;

      case 'sfp-check':
        emit('sfp:check', msg);
        break;

      // 1.3: Chart Watchers panel — snapshot of the real running watcher set
      case 'watchers-status':
        emit('watchers:status', msg.data || null);
        break;

      // 2.3: armed-setup slot + decision result
      case 'armed-setup':
        emit('signal:armedSetup', msg.setup || null);
        break;

      case 'signal-decision-result':
        emit('signal:decisionResult', msg);
        break;

      // 4.3: the server's live-feed writer updated the durable day record
      case 'day-record-updated':
        emit('dayRecord:updated', msg);
        // 2026-09-02: the exit-drift panel used to learn about a new trade
        // ONLY from its own 60s poll, so it could show a stale anchor for up
        // to a minute after a close. This is the last-trade signal — the same
        // broadcast that wrote the row — so ask for a re-read immediately.
        // Safe to fire on every close: exit-drift.js still withholds the
        // verdict inside its post-trade cooldown (COOLING), so this makes the
        // panel current without turning it into a regret feed.
        try { if (typeof requestExitDrift === 'function') requestExitDrift(); }
        catch (e) { console.warn('[exit-drift] refresh-on-trade failed:', e.message); }
        break;

      // 5.2/H6: scorecard data + the per-trade attribution gate status
      case 'h6-status':
        emit('h6:status', msg);
        break;

      case 'scorecard-data':
        emit('scorecard:data', msg);
        break;

      case 'playbook-b-signal':
        emit('sfp:playbookB', msg);
        break;

      case 'london-levels':
        emit('london:levels', msg);
        break;

      // FIX (2026-07-27): server.js has broadcast 'ny-levels' since NY level
      // marking was built — this case just never existed, so "Mark NY
      // Levels" silently did nothing client-side (server drew the lines fine,
      // the app never told Anoop it happened or that it failed). Found while
      // compacting the London-levels status pill and noticing NY had no
      // equivalent to compact in the first place.
      case 'ny-levels':
        emit('ny:levels', msg);
        break;

      case 'auto-end-day-trigger':
        emit('endDay:autoTrigger', msg);
        break;

      case 'news-status':
        emit('news:status', msg);
        break;

      case 'tradovate-account':
        emit('tradovate:account', msg);
        break;

      // 2026-08-17: server has been broadcasting this since the TradingView
      // broker-feed monitor was built, but nothing client-side ever listened
      // for it — confirmed live, silently dropped every 10s. This is the fix.
      case 'tv-broker-account':
        emit('tv:brokerAccount', msg);
        break;

      // 2026-08-19: startup/reconnect self-test result (SEMI_AUTONOMOUS_SYSTEM_PLAN.md item 2).
      case 'live-feed-self-test':
        emit('tv:liveFeedSelfTest', msg);
        break;

      // 2026-08-19: live mistake-pattern match against Anoop's own documented
      // failure history (mistake-patterns.js). F1 first, advisory only.
      case 'mistake-pattern':
        emit('tv:mistakePattern', msg);
        break;

      // 2026-09-03: THE LOOP — the pattern-memory agent's reasoned answer to a
      // REPEAT. Distinct from 'mistake-pattern' above, which is the fast
      // deterministic detector: this one arrives only when something has
      // happened before, and carries the recurrence record with it.
      case 'loop-feedback':
        emit('loop:feedback', msg);
        break;

      // 2026-08-20: the fast open/close/scale/flip tick (5s positions watch,
      // see server.js's TV_POSITION_WATCH_MS). Arrives BEFORE the fuller
      // tv-broker-account broadcast that follows it — this one says "something
      // just changed", that one carries the authoritative P&L/count.
      case 'position-event':
        emit('tv:positionEvent', msg);
        break;

      // A trade the fold has actually closed and scored: already written to
      // today's session log server-side, announced here so it lands in chat.
      // 2026-08-20: per-trade P&L agreement between the balance-delta fold
      // and an independent fill-price derivation. Visibility only.
      case 'pnl-cross-check':
        emit('tv:pnlCrossCheck', msg);
        break;

      case 'trade-closed-live':
        emit('tv:tradeClosedLive', msg);
        break;

      case 'tradovate-test-result':
        emit('tradovate:testResult', msg);
        break;

      case 'news-chart-marks':
        emit('news:chartMarks', msg);
        break;

      case 'mechanical-analysis':
        emit('mechanical:analysis', msg);
        break;

      // Bias-adherence coach note, pushed after ✓ PRE-TRADE DONE (2026-08-13).
      case 'bias-note':
        emit('bias:note', msg);
        break;

      // 2026-09-02: which side the watchers are looking at, per 1H/4H, plus
      // the proof it is a live read (bar time, age, armed watcher count).
      case 'htf-status':
        emit('htf:status', msg);
        break;

      // Startup bar-record self-repair outcome.
      case 'bar-record-repair':
        emit('bars:repair', msg);
        break;

      case 'session-alert':
        emit('session:alert', msg);
        break;

      // ── Session / screenshot ──────────────────────────────────────────────
      case 'session-started':
      case 'session-trade-logged':
      case 'session-data':
      case 'session-list':
      case 'screenshot-data':
      case 'data-saved':
      case 'data-loaded':
      case 'pdf-extracted':
      case 'xlsx-extracted':
      case 'data-wiped':
      case 'data-end-day-saved':
      case 'data-dir':
      case 'note-saved':
      case 'shot-saved':
      case 'shot-list':
      case 'shot-data':
      case 'account-db-result':
      case 'journey-list':
      case 'journey-result':
      // Weekly Report (2026-08-29). Every week-* request answers with this ONE
      // message type carrying the whole tab state, so the client never has to
      // merge a partial update into a stale view — and so the tab, the Saturday
      // markdown and the Telegram push can never disagree about a number.
      case 'week-report-data':
        resolvePending(msg.reqId, msg);
        break;

      // Forensics tab (2026-09-05): one request, one whole-tab payload.
      case 'forensics-data':
        resolvePending(msg.reqId, msg);
        break;

      // ── Rules (single source of truth from rules.json) ───────────────────
      case 'rules':
        window.RULES = msg.data || window.RULES;
        emit('rules:data', msg.data);
        if (msg.reqId) resolvePending(msg.reqId, msg);
        // Sync trading mode toggle when rules arrive
        if (msg.data && msg.data.tradingMode && typeof applyTradingModeUI === 'function') {
          applyTradingModeUI(msg.data.tradingMode);
        }
        break;

      // A finished week was auto-frozen and its note written. Pushed, not
      // polled, so the nudge arrives even if the Week tab has never been opened.
      case 'week-ready':
        if (typeof wkOnWeekReady === 'function') wkOnWeekReady(msg);
        break;

      case 'health-protocol-report':
        if (typeof renderHealthProtocol === 'function') renderHealthProtocol(msg);
        break;
      case 'feed-protocol-report':
        if (typeof renderFeedProtocol === 'function') renderFeedProtocol(msg);
        break;
      case 'self-repair':
        // A mismatch the app FIXED, with the evidence of what it did. Anoop
        // asked for exactly this: not a number that quietly becomes right,
        // but a visible record that the correction happened.
        if (typeof renderSelfRepair === 'function') renderSelfRepair(msg);
        break;
      case 'shadow-ticket':
        // The shadow trade ticket — direction, stop/target in dollars AND
        // ticks, and why the setup was confirmed. Rendered into chat because
        // that is the surface Anoop actually reads during a session.
        if (typeof renderShadowTicket === 'function') renderShadowTicket(msg);
        break;
      case 'autonomy-status':
        // Renders the EFFECTIVE mode, not the requested one — see
        // applyControlUI in app.js for why that distinction is load-bearing.
        if (typeof applyControlUI === 'function') applyControlUI(msg);
        break;
      case 'trading-mode':
        if (typeof applyTradingModeUI === 'function') applyTradingModeUI(msg.mode || 'standard');
        if (msg.reqId) resolvePending(msg.reqId, msg);
        break;

      // ── Chat archive (2026-09-03) ─────────────────────────────────────────
      // The ack for one appended batch. chat-archive.js (renderer) keeps the
      // batch in its outbox until this arrives, so a message is never counted
      // as archived merely because it was handed to a socket.
      case 'chat-archive-appended':
        emit('chatArchive:appended', msg);
        if (msg.reqId) resolvePending(msg.reqId, msg);
        break;
      case 'chat-archive-result':
        emit('chatArchive:result', msg);
        if (msg.reqId) resolvePending(msg.reqId, msg);
        break;

      default: break;
    }
  }

  function rawSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function sendRequest(obj, timeoutMs) {
    return new Promise((resolve, reject) => {
      const reqId = ++reqCounter;
      obj.reqId = reqId;
      pending.set(reqId, { resolve, reject });
      rawSend(obj);
      const t = setTimeout(() => {
        if (pending.has(reqId)) { pending.delete(reqId); reject(new Error('Request timeout')); }
      }, timeoutMs || 30000);
      const orig = pending.get(reqId);
      pending.set(reqId, {
        resolve: (v) => { clearTimeout(t); orig.resolve(v); },
        reject:  (e) => { clearTimeout(t); orig.reject(e);  }
      });
    });
  }

  function resolvePending(reqId, data) {
    const p = pending.get(reqId);
    if (p) { pending.delete(reqId); p.resolve(data); }
  }

  // ── Public window.api ────────────────────────────────────────────────────────
  window.api = {

    // Fire-and-forget message to the server.
    //
    // ADDED 2026-08-26 to fix a bug that had been live since the Standard/
    // Scalper toggle shipped on 2026-08-01: app.js's switchTradingMode() did
    // `if (ws && ws.readyState === 1) ws.send(...)`, but `ws` is declared with
    // `let` INSIDE this IIFE and was never exposed on window. So the reference
    // threw ReferenceError, the send never happened, AND the line after it
    // (applyTradingModeUI) never ran — which is why the button did not even
    // move. The toggle was dead in both directions: it could not tell the
    // server anything, and it could not show that it had failed.
    //
    // The scalper RULES were always real (rules.json scalperRules changes
    // tradesPerDay, maxHoldSeconds and the daily loss tiers); only the button
    // was broken. `applyTradingModeUI` is still called from the config
    // handler above, so the button always rendered the server's actual mode —
    // which is exactly why this looked like a working toggle that "did
    // nothing" rather than an obviously broken one.
    //
    // Returns true if the message actually went out, so a caller can tell the
    // difference between "sent" and "socket was down" instead of assuming.
    send: (obj) => {
      if (!ws || ws.readyState !== 1) return false;
      try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
    },

    // Config
    getConfig: () => {
      if (cachedConfig) return Promise.resolve(cachedConfig);
      return new Promise(r => on('config:data', r));
    },
    setConfig: (key, value) => {
      // AUDIT FIX 2026-07-25: also update the local cache. Without this,
      // getConfig() kept returning the PRE-SAVE config until the page was
      // reloaded (the cache was only ever written on WS connect) — so e.g.
      // pasting an API key in Settings didn't take effect for chat routing
      // until a manual refresh. This was the long-documented "getConfig
      // staleness" bug class, finally fixed at the source.
      if (cachedConfig) cachedConfig[key] = value;
      rawSend({ type: 'config-set', key, value });
      return Promise.resolve(true);
    },

    // Chat — returns a promise that resolves when done/error
    sendChat: (messages) => {
      const reqId = ++reqCounter;
      currentReqId = reqId;
      rawSend({ type: 'chat-send', messages, reqId });

      return new Promise((resolve, reject) => {
        // Same hang-guard as sendJessiChat — server side already has a 5-min
        // timeout (claude-agent.js), so 5.5 min here only catches the case
        // where the WS died and no terminal message can ever arrive.
        const t = setTimeout(() => { cleanup(); reject(new Error('No response within 5.5 minutes — connection may have dropped.')); }, 330 * 1000);
        function onDone(text)  { cleanup(); resolve(text); }
        function onErr(msg)    { cleanup(); reject(new Error(msg)); }
        function cleanup() {
          clearTimeout(t);
          off('chat:done',  onDone);
          off('chat:error', onErr);
        }
        on('chat:done',  onDone);
        on('chat:error', onErr);
      });
    },

    // 2026-08-06: was local-only (cleared UI state, never told the server) —
    // the server kept generating and burning API quota in the background
    // even after "cancel" was clicked. Now sends 'cancel-request' so the
    // in-flight claudeAgent.stream()/groqAgent.stream() call actually aborts.
    cancelChat: () => {
      if (currentReqId != null) rawSend({ type: 'cancel-request', reqId: currentReqId });
      currentReqId = null;
      emit('chat:done', '');
    },

    onChatToken:    (cb) => on('chat:token',     cb),
    onChatToolStart:(cb) => on('chat:toolStart',  cb),
    onChatToolDone: (cb) => on('chat:toolDone',   cb),
    onChatDone:     (cb) => on('chat:done',       cb),
    onChatError:    (cb) => on('chat:error',      cb),

    // Jessi chat (Groq-backed) — returns a promise that resolves when done/error
    sendJessiChat: (messages) => {
      const reqId = ++reqCounter;
      currentJessiReqId = reqId;
      rawSend({ type: 'jessi-chat-send', messages, reqId });

      return new Promise((resolve, reject) => {
        // AUDIT FIX 2026-07-25: if the WS drops mid-turn the server's done/
        // error message never arrives and this promise hung FOREVER —
        // state.isStreaming stayed true and the send button was dead until a
        // page reload. 4-minute ceiling (a turn can legitimately include a
        // 30s rate-limit wait + a 90s retried stream + tool rounds).
        const t = setTimeout(() => { cleanup(); reject(new Error('Jessi did not respond within 4 minutes — connection may have dropped. Try again.')); }, 240 * 1000);
        function onDone(text, answeredBy) { cleanup(); resolve({ text, answeredBy }); }
        function onErr(msg)   { cleanup(); reject(new Error(msg)); }
        function cleanup() {
          clearTimeout(t);
          off('jessiChat:done',  onDone);
          off('jessiChat:error', onErr);
        }
        on('jessiChat:done',  onDone);
        on('jessiChat:error', onErr);
      });
    },
    cancelJessiChat: () => {
      if (currentJessiReqId != null) rawSend({ type: 'cancel-request', reqId: currentJessiReqId });
      currentJessiReqId = null;
      emit('jessiChat:done', '');
    },
    onJessiChatModeHint:  (cb) => on('jessiChat:modeHint', cb),
    onJessiChatToken:     (cb) => on('jessiChat:token',    cb),
    onJessiChatToolStart: (cb) => on('jessiChat:toolStart', cb),
    onJessiChatToolDone:  (cb) => on('jessiChat:toolDone',  cb),
    onJessiChatFallback:  (cb) => on('jessiChat:fallback', cb),
    onJessiChatQuotaWarn: (cb) => on('jessiChat:quotaWarn', cb),
    onJessiChatDone:      (cb) => on('jessiChat:done',     cb),
    onJessiChatError:     (cb) => on('jessiChat:error',    cb),

    // The Scalper (2026-08-01) — scalping specialist agent. Same promise
    // shape as sendJessiChat, including the hung-promise timeout guard.
    sendScalperChat: (messages) => {
      const reqId = ++reqCounter;
      currentScalperReqId = reqId;
      rawSend({ type: 'scalper-chat-send', messages, reqId });
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { cleanup(); reject(new Error('The Scalper did not respond within 4 minutes — connection may have dropped. Try again.')); }, 240 * 1000);
        function onDone(text, answeredBy) { cleanup(); resolve({ text, answeredBy }); }
        function onErr(msg)   { cleanup(); reject(new Error(msg)); }
        function cleanup() {
          clearTimeout(t);
          off('scalper:done',  onDone);
          off('scalper:error', onErr);
        }
        on('scalper:done',  onDone);
        on('scalper:error', onErr);
      });
    },
    cancelScalperChat: () => {
      if (currentScalperReqId != null) rawSend({ type: 'cancel-request', reqId: currentScalperReqId });
      currentScalperReqId = null;
      emit('scalper:done', '');
    },
    onScalperToken:     (cb) => on('scalper:token',     cb),
    onScalperToolStart: (cb) => on('scalper:toolStart', cb),
    onScalperToolDone:  (cb) => on('scalper:toolDone',  cb),
    onScalperFallback:  (cb) => on('scalper:fallback',  cb),
    onScalperDone:      (cb) => on('scalper:done',      cb),
    onScalperError:     (cb) => on('scalper:error',     cb),

    // Jessi voice mode — fire-and-forget send; results arrive via the
    // event listeners below (transcript first, then audio clips).
    sendJessiVoice: (audioBase64, mimeType, messages) => {
      const reqId = ++reqCounter;
      currentJessiVoiceReqId = reqId;
      rawSend({ type: 'jessi-voice-send', audioBase64, mimeType, messages, reqId });
    },
    // Browser-native voice: browser did the STT, will do the TTS — send the
    // transcript text (no audio) and ask the server to skip Groq TTS.
    sendJessiVoiceText: (transcript, messages) => {
      const reqId = ++reqCounter;
      currentJessiVoiceReqId = reqId;
      rawSend({ type: 'jessi-voice-send', transcript, clientTts: true, messages, reqId });
    },
    cancelJessiVoice: () => {
      if (currentJessiVoiceReqId != null) rawSend({ type: 'cancel-request', reqId: currentJessiVoiceReqId });
      currentJessiVoiceReqId = null;
    },
    onJessiVoiceTranscript: (cb) => on('jessiVoice:transcript', cb),
    onJessiVoiceToolStart:  (cb) => on('jessiVoice:toolStart',  cb),
    onJessiVoiceToolDone:   (cb) => on('jessiVoice:toolDone',   cb),
    onJessiVoiceFallback:   (cb) => on('jessiVoice:fallback',   cb),
    onJessiVoiceQuotaWarn:  (cb) => on('jessiVoice:quotaWarn',  cb),
    onJessiVoiceAudio:      (cb) => on('jessiVoice:audio',      cb),
    onJessiVoiceError:      (cb) => on('jessiVoice:error',      cb),

    // 3-Agent Debate (Jessi + Analysis → Expert Judge)
    sendDebateChat: (messages) => {
      const reqId = ++reqCounter;
      currentDebateReqId = reqId;
      rawSend({ type: 'debate-chat-send', messages, reqId });
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { cleanup(); reject(new Error('Debate timed out (5 min) — connection may have dropped.')); }, 300 * 1000);
        function onDone(text, answeredBy) { cleanup(); resolve({ text, answeredBy }); }
        function onErr(msg)   { cleanup(); reject(new Error(msg)); }
        function cleanup() {
          clearTimeout(t);
          off('debate:judgeDone',  onDone);
          off('debate:judgeError', onErr);
        }
        on('debate:judgeDone',  onDone);
        on('debate:judgeError', onErr);
      });
    },
    cancelDebateChat:      () => {
      if (currentDebateReqId != null) rawSend({ type: 'cancel-request', reqId: currentDebateReqId });
      currentDebateReqId = null;
      emit('debate:judgeDone', '');
    },
    onDebateStatus:        (cb) => on('debate:status',     cb),
    onDebateArguments:     (cb) => on('debate:arguments',  cb),
    onDebateJudgeToken:    (cb) => on('debate:judgeToken', cb),
    onDebateJudgeDone:     (cb) => on('debate:judgeDone',  cb),
    onDebateJudgeError:    (cb) => on('debate:judgeError', cb),
    onDebateRefutation:    (cb) => on('debate:refutation', cb),
    // 2026-08-17: PO3-monitor-triggered debate — parallel channel, see the
    // 'auto-debate-triggered'/currentAutoDebateReqId handling above.
    onDebateAutoTriggered:  (cb) => on('debate:autoTriggered',  cb),
    onDebateAutoStatus:     (cb) => on('debate:autoStatus',     cb),
    onDebateAutoArguments:  (cb) => on('debate:autoArguments',  cb),
    onDebateAutoJudgeToken: (cb) => on('debate:autoJudgeToken', cb),
    onDebateAutoJudgeDone:  (cb) => on('debate:autoJudgeDone',  cb),
    onDebateAutoJudgeError: (cb) => on('debate:autoJudgeError', cb),

    // Post-Session Analyst (auto-fires after CSV ingest)
    sendPostSessionReview: () => {
      const reqId = ++reqCounter;
      currentPostReviewReqId = reqId;
      rawSend({ type: 'post-session-review', reqId });
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { cleanup(); reject(new Error('Post-session review timed out (5 min).')); }, 300 * 1000);
        function onDone(text, answeredBy) { cleanup(); resolve({ text, answeredBy }); }
        function onErr(msg)   { cleanup(); reject(new Error(msg)); }
        function cleanup() {
          clearTimeout(t);
          off('postReview:done',  onDone);
          off('postReview:error', onErr);
        }
        on('postReview:done',  onDone);
        on('postReview:error', onErr);
      });
    },
    onPostReviewStatus: (cb) => on('postReview:status', cb),
    onPostReviewToken:  (cb) => on('postReview:token',  cb),
    onPostReviewDone:   (cb) => on('postReview:done',   cb),
    onPostReviewError:  (cb) => on('postReview:error',  cb),

    // ICT Power of 3 — AMD phase read (multi-TF, weights 15m + 5m)
    sendIctPo3: (question) => {
      const reqId = ++reqCounter;
      currentPo3ReqId = reqId;
      rawSend({ type: 'ict-po3', question, reqId });
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { cleanup(); reject(new Error('Power of 3 analysis timed out (3 min).')); }, 180 * 1000);
        function onDone(text, answeredBy) { cleanup(); resolve({ text, answeredBy }); }
        function onErr(m)     { cleanup(); reject(new Error(m)); }
        function cleanup() { clearTimeout(t); off('po3:done', onDone); off('po3:error', onErr); }
        on('po3:done', onDone);
        on('po3:error', onErr);
      });
    },
    // Power of 3 phase monitor
    togglePo3Monitor: (enabled) => rawSend({ type: 'po3-monitor-toggle', enabled }),
    checkPo3Now:      ()        => rawSend({ type: 'po3-check-now' }),
    onPo3PhaseChange:   (cb) => on('po3:phaseChange',   cb),
    onPo3MonitorStatus: (cb) => on('po3:monitorStatus', cb),
    onPo3MonitorCheck:  (cb) => on('po3:monitorCheck',  cb),

    onPo3Status: (cb) => on('po3:status', cb),
    onPo3Token:  (cb) => on('po3:token',  cb),
    onPo3Done:   (cb) => on('po3:done',   cb),
    onPo3Error:  (cb) => on('po3:error',  cb),

    // Per-account dataset management (2026-07-25, D:\\co-pilot DATA)
    dataWipeAccount: (slotId)            => sendRequest({ type: 'data-wipe-account', slotId }).then(r => r.ok),
    dataEndDay:      (slotId, date, payload) => sendRequest({ type: 'data-end-day', slotId, date, payload }),
    dataDirGet:      ()                  => sendRequest({ type: 'data-dir-get' }).then(r => r.dir),
    accountDbRebuild: () => sendRequest({ type: 'account-db-rebuild' }, 20000).then(r => r),

    // Account journeys — single eval→funded lifecycle dataset (2026-08-16, journey-tracker.js)
    journeyList:   () => sendRequest({ type: 'journey-list' }).then(r => r.journeys || []),
    journeyAction: (action, args) => sendRequest(Object.assign({ type: 'journey-action', action }, args || {})).then(r => r),

    // Daily Journal: per-account notes + chart screenshots (2026-07-25)
    // ── Weekly Report (2026-08-29) ──────────────────────────────────────────
    // All four resolve with the same full 'week-report-data' payload, so a
    // save re-renders from the server's own recomputation rather than from
    // what the client hoped it wrote.
    // Forensics (2026-09-05): MAE/MFE per trade, conditional expectancy,
    // counterfactuals. Computed entirely server-side; see forensics-report.js.
    forensics:    ()                    => sendRequest({ type: 'forensics-get' }, 20000),
    weekReport:   (offset)              => sendRequest({ type: 'week-report-get', offset: offset || 0 }, 20000),
    weekCommit:   (weekKey, commitment) => sendRequest({ type: 'week-commit-set', weekKey, commitment }, 20000),
    weekDoctrine: (text)                => sendRequest({ type: 'week-doctrine-set', text }, 20000),
    weekFreeze:   (weekKey)             => sendRequest({ type: 'week-freeze', weekKey }, 20000),

    noteSave: (slotId, date, note) => sendRequest({ type: 'note-save', slotId, date, note }).then(r => r.ok),
    shotSave: (slotId, date, base64, ext) => sendRequest({ type: 'shot-save', slotId, date, base64, ext }).then(r => r.file),
    shotList: (slotId, date)        => sendRequest({ type: 'shot-list', slotId, date }).then(r => r.files || []),
    shotRead: (slotId, file)        => sendRequest({ type: 'shot-read', slotId, file }).then(r => r.dataUrl),

    // Trade journal (free-text, not account-scoped)
    journalAdd: (text) => sendRequest({ type: 'journal-add', text }),

    // MCP
    mcpCall:    (name, args) => sendRequest({ type: 'mcp-call', name, args }),
    getMcpStatus: ()         => Promise.resolve({ connected: window._mcpConnected || false }),

    // Sessions
    startSession: (data)  => sendRequest({ type: 'session-start', data }).then(r => r.data),
    logTrade:     (trade) => sendRequest({ type: 'session-trade', trade }).then(r => r.data),
    readSession:  (date)  => sendRequest({ type: 'session-read', date }).then(r => r.data),
    listSessions: ()      => sendRequest({ type: 'session-list' }).then(r => r.data),

    // Screenshots
    getScreenshot: (filePath) => sendRequest({ type: 'screenshot-get', filePath }).then(r => r.data),

    // Mode
    switchMode: (mode) => rawSend({ type: 'mode-switch', mode }),

    // Engulf monitor
    toggleEngulfMonitor: (tf, enabled) => rawSend({ type: 'engulf-monitor-toggle', tf, enabled }),
    checkEngulfNow:      (tf)          => rawSend({ type: 'engulf-check-now', tf }),

    // FVG monitor
    toggleFVGMonitor: (tf, enabled) => rawSend({ type: 'fvg-monitor-toggle', tf, enabled }),
    checkFVGNow:      (tf)          => rawSend({ type: 'fvg-check-now', tf }),

    // SFP / Playbook B monitor
    toggleSFPMonitor: (tf, enabled) => rawSend({ type: 'sfp-monitor-toggle', tf, enabled }),
    checkSFPNow:      (tf)          => rawSend({ type: 'sfp-check-now', tf }),

    // London prep (PDH/PDL + Asia H/L, drawn on chart)
    markLondonLevels: () => rawSend({ type: 'mark-london-levels' }),

  // NY prep (current week H/L + current month H/L, drawn on chart — redefined 2026-07-22)
  markNYLevels: () => rawSend({ type: 'mark-ny-levels' }),

    // Economic calendar / no-trade windows
    refreshNews: () => rawSend({ type: 'news-refresh' }),
    markNewsOnChart: () => rawSend({ type: 'mark-news-times' }),

    // Mechanical HTF alignment / key level (no LLM)
    requestMechanicalCheck: () => rawSend({ type: 'mechanical-check' }),

    // Status events
    onMcpConnected:    (cb) => on('mcp:connected',     cb),
    onMcpDisconnected: (cb) => on('mcp:disconnected',  cb),
    onMcpStatus:       (cb) => on('mcp:status',        cb),
    onModeUpdate:      (cb) => on('mode:update',       cb),
    // Oversize guard: state on demand, and the explicit session switch.
    getOversizeStatus: () => rawSend({ type: 'oversize-guard-status' }),
    setOversizeGuard:  (enabled) => rawSend({ type: 'oversize-guard-toggle', enabled: !!enabled }),
    onOversizeStatus:  (cb) => on('oversize:status',   cb),
    onOversizeEvent:   (cb) => on('oversize:event',    cb),
  onPerTradeStopEvent: (cb) => on('pertradestop:event', cb),
    onEngulfSignal:    (cb) => on('engulf:signal',     cb),
    onEngulfMonStatus: (cb) => on('engulf:monitorStatus', cb),
    onEngulfCheck:     (cb) => on('engulf:check',      cb),
    onFVGSignal:       (cb) => on('fvg:signal',        cb),
    onFVGMonStatus:    (cb) => on('fvg:monitorStatus', cb),
    onFVGCheck:        (cb) => on('fvg:check',         cb),
    onSFPSignal:       (cb) => on('sfp:signal',        cb),
    onSFPMonStatus:    (cb) => on('sfp:monitorStatus', cb),
    onSFPCheck:        (cb) => on('sfp:check',         cb),
    // 1.3: Chart Watchers panel
    getWatchers:       ()  => sendRequest({ type: 'watchers-get' }).then(r => r.data),
    onWatchersStatus:  (cb) => on('watchers:status', cb),
    onHtfStatus:       (cb) => on('htf:status', cb),
    onBarsRepair:      (cb) => on('bars:repair', cb),
    // 2.3: armed-setup slot + Took it / Passed decisions
    onArmedSetup:          (cb) => on('signal:armedSetup', cb),
    onSignalDecisionResult:(cb) => on('signal:decisionResult', cb),
    signalDecision:    (signalTs, decision) => rawSend({ type: 'signal-decision', signalTs, decision }),
    getArmedSetup:     ()  => sendRequest({ type: 'armed-setup-get' }).then(r => r.setup),
    // 4.3: live-feed day-record sync
    onDayRecordUpdated: (cb) => on('dayRecord:updated', cb),
    // 5.2/H6: scorecard
    getH6Status:   () => sendRequest({ type: 'h6-get' }).then(r => r),
    onH6Status:    (cb) => on('h6:status', cb),
    getScorecard:  () => sendRequest({ type: 'scorecard-get' }).then(r => r),
    onScorecardData: (cb) => on('scorecard:data', cb),
    onPlaybookBSignal: (cb) => on('sfp:playbookB',     cb),
    onLondonLevels:    (cb) => on('london:levels',     cb),
    onNyLevels:        (cb) => on('ny:levels',         cb), // FIX 2026-07-27 — see ws-client.js case 'ny-levels' note
    onNewsStatus:      (cb) => on('news:status',       cb),
    onEndDayAutoTrigger:(cb)=> on('endDay:autoTrigger', cb),
    onTradovateAccount:(cb) => on('tradovate:account',  cb),
    onTvBrokerAccount: (cb) => on('tv:brokerAccount',   cb),
    onLiveFeedSelfTest: (cb) => on('tv:liveFeedSelfTest', cb),
    onMistakePattern:  (cb) => on('tv:mistakePattern',    cb),
    onLoopFeedback:    (cb) => on('loop:feedback',        cb),
    // Ask the Loop to speak now — see server.js's 'loop-run' case for why an
    // explicit ask bypasses the once-per-day gate but not the repeat bar.
    runLoop: (opts) => sendRequest(Object.assign({ type: 'loop-run' }, opts || {})),
    onPositionEvent:   (cb) => on('tv:positionEvent',     cb),
    onTradeClosedLive: (cb) => on('tv:tradeClosedLive',   cb),
    onPnlCrossCheck:   (cb) => on('tv:pnlCrossCheck',     cb),
    // Server already handles 'tv-broker-check-now' (an immediate out-of-band
    // account read); there was simply no client-side caller for it until the
    // position watch needed to pull the authoritative numbers forward.
    checkTvBrokerNow:  ()   => rawSend({ type: 'tv-broker-check-now' }),
    runLiveFeedSelfTest: () => rawSend({ type: 'live-feed-selftest-run' }),
    onTradovateTestResult:(cb)=> on('tradovate:testResult', cb),
    testTradovate:     ()   => rawSend({ type: 'tradovate-test' }),
    restartTradovate:  ()   => rawSend({ type: 'tradovate-restart' }),
    onNewsChartMarks:  (cb) => on('news:chartMarks',   cb),
    onMechanicalAnalysis: (cb) => on('mechanical:analysis', cb),
    onBiasNote:        (cb) => on('bias:note',          cb),
    checklistDone:     (record) => rawSend({ type: 'checklist-done', record: record }),
    onSessionAlert:    (cb) => on('session:alert',     cb),
    onWsOpen:          (cb) => on('ws:open',           cb),

    // Phase 2b: trade confirm/execute (2026-08-17). requestId is generated
    // HERE, client-side, unique per Confirm click — it is the dedup key the
    // server uses to refuse a double-click/replay (see server.js's
    // handleTradeConfirm). One requestId per call, never reused by the caller.
    onTradeTicketSuggested: (cb) => on('trade:ticketSuggested', cb),
    sendTradeConfirm: (payload) => {
      const requestId = 'tc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
      // payload spread FIRST, type/requestId applied LAST — a caller-supplied
      // `type` or `requestId` in payload can never override the ones this
      // function controls.
      rawSend(Object.assign({}, payload, { type: 'trade-confirm-request', requestId }));
      return requestId;
    },
    onTradeConfirmResult:   (cb) => on('trade:confirmResult',   cb),
    onTradeConfirmRejected: (cb) => on('trade:confirmRejected', cb),
    onSessionLogFailed:     (cb) => on('session:logFailed',     cb),

    // Rules (rules.json on the server is the single source of truth)
    getRules:  () => sendRequest({ type: 'rules-get' }).then(r => r.data),
    setRules:  (data) => rawSend({ type: 'rules-set', data }),
    onRules:   (cb) => on('rules:data', cb),

    // Durable local data (data/ folder on disk — survives cache clears)
    dataSave: (key, payload) => sendRequest({ type: 'data-save', key, payload }).then(r => r.ok),
    dataLoad: (key)          => sendRequest({ type: 'data-load', key }).then(r => r.data),

    // PDF text extraction (server-side pdf-parse, for PDF uploads in Update File)
    pdfExtract: (base64) => sendRequest({ type: 'pdf-extract', base64 }).then(r => {
      if (!r.ok) throw new Error(r.error || 'PDF extraction failed');
      return r.text;
    }),
    // 2026-08-17: Excel (.xlsx/.xls) — same request/response shape as
    // pdfExtract above, server converts the first sheet straight to CSV.
    xlsxExtract: (base64) => sendRequest({ type: 'xlsx-extract', base64 }).then(r => {
      if (!r.ok) throw new Error(r.error || 'Spreadsheet extraction failed');
      return r.csv;
    }),

    // Read-aloud: any chat text → Edge TTS clips (en-IN neural, same voice as
    // voice mode). Pure TTS, no LLM call — zero tokens per replay.
    // 90s timeout, not the default 30s — long replies (Post-Session Review,
    // debate verdicts) get split into several sequential TTS round-trips.
    speakText: (text, voice) => sendRequest({ type: 'tts-speak', text, voice }, 90000).then(r => {
      if (!r.ok) throw new Error(r.error || 'Text-to-speech failed');
      return { clips: r.clips, mime: r.mime, engine: r.engine };
    }),

    // Diagnostic — which TTS engines work on this machine, and why not.
    ttsDiagnose: () => sendRequest({ type: 'tts-diagnose' }, 90000),

    // ── Chat archive (2026-09-03) — see app/chat-archive.js ────────────────
    // Append is fire-and-forget at THIS layer on purpose: the caller owns an
    // outbox and retries on the ack, so a promise that rejects on a closed
    // socket would just duplicate bookkeeping that already exists there.
    // Returns whether the batch actually left the socket.
    chatArchiveAppend: (rows, batchId) => window.api.send({ type: 'chat-archive-append', rows, batchId }),
    onChatArchiveAppended: (cb) => on('chatArchive:appended', cb),
    chatArchiveQuery: (opts) => sendRequest(Object.assign({ type: 'chat-archive-query' }, opts || {}))
      .then(r => (r && r.error) ? Promise.reject(new Error(r.error)) : (r && r.data)),
    patternMemoryQuery: (opts) => sendRequest(Object.assign({ type: 'pattern-memory-query' }, opts || {}))
      .then(r => (r && r.error) ? Promise.reject(new Error(r.error)) : (r && r.data)),

    removeAllListeners: () => { Object.keys(listeners).forEach(k => { listeners[k] = []; }); }
  };

  // Track MCP state
  on('mcp:connected',    () => { window._mcpConnected = true; });
  on('mcp:disconnected', () => { window._mcpConnected = false; });

  connect();
})();
