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
          emit('jessiChat:done', msg.fullText);
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

      case 'scalper-done':
        if (msg.reqId === currentScalperReqId) {
          currentScalperReqId = null;
          emit('scalper:done', msg.fullText);
        }
        break;

      case 'scalper-error':
        if (msg.reqId === currentScalperReqId) {
          currentScalperReqId = null;
          emit('scalper:error', msg.message);
        }
        break;

      // ── 3-Agent Debate mode ──────────────────────────────────────────────
      case 'debate-status':
        if (msg.reqId === currentDebateReqId) emit('debate:status', msg.phase);
        break;
      case 'debate-arguments':
        if (msg.reqId === currentDebateReqId) emit('debate:arguments', msg.jessi, msg.analysis, msg.po3);
        break;
      case 'debate-judge-token':
        if (msg.reqId === currentDebateReqId) emit('debate:judgeToken', msg.text);
        break;
      case 'debate-judge-done':
        if (msg.reqId === currentDebateReqId) {
          currentDebateReqId = null;
          emit('debate:judgeDone', msg.fullText);
        }
        break;
      case 'debate-judge-error':
        if (msg.reqId === currentDebateReqId) {
          currentDebateReqId = null;
          emit('debate:judgeError', msg.message);
        }
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
          emit('postReview:done', msg.fullText);
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
        if (msg.reqId === currentPo3ReqId) { currentPo3ReqId = null; emit('po3:done', msg.fullText); }
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
          emit('jessiVoice:audio', msg.fullText, msg.clips, msg.mime);
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

      case 'news-status':
        emit('news:status', msg);
        break;

      case 'tradovate-account':
        emit('tradovate:account', msg);
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
      case 'data-wiped':
      case 'data-end-day-saved':
      case 'data-dir':
      case 'note-saved':
      case 'shot-saved':
      case 'shot-list':
      case 'shot-data':
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

      case 'trading-mode':
        if (typeof applyTradingModeUI === 'function') applyTradingModeUI(msg.mode || 'standard');
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

    cancelChat: () => {
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
        function onDone(text) { cleanup(); resolve(text); }
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
    cancelJessiChat: () => { currentJessiReqId = null; emit('jessiChat:done', ''); },
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
        function onDone(text) { cleanup(); resolve(text); }
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
    cancelScalperChat: () => { currentScalperReqId = null; emit('scalper:done', ''); },
    onScalperToken:     (cb) => on('scalper:token',     cb),
    onScalperToolStart: (cb) => on('scalper:toolStart', cb),
    onScalperToolDone:  (cb) => on('scalper:toolDone',  cb),
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
    cancelJessiVoice: () => { currentJessiVoiceReqId = null; },
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
        function onDone(text) { cleanup(); resolve(text); }
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
    cancelDebateChat:      () => { currentDebateReqId = null; emit('debate:judgeDone', ''); },
    onDebateStatus:        (cb) => on('debate:status',     cb),
    onDebateArguments:     (cb) => on('debate:arguments',  cb),
    onDebateJudgeToken:    (cb) => on('debate:judgeToken', cb),
    onDebateJudgeDone:     (cb) => on('debate:judgeDone',  cb),
    onDebateJudgeError:    (cb) => on('debate:judgeError', cb),

    // Post-Session Analyst (auto-fires after CSV ingest)
    sendPostSessionReview: () => {
      const reqId = ++reqCounter;
      currentPostReviewReqId = reqId;
      rawSend({ type: 'post-session-review', reqId });
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { cleanup(); reject(new Error('Post-session review timed out (5 min).')); }, 300 * 1000);
        function onDone(text) { cleanup(); resolve(text); }
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
        function onDone(text) { cleanup(); resolve(text); }
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

    // Daily Journal: per-account notes + chart screenshots (2026-07-25)
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
    onEngulfSignal:    (cb) => on('engulf:signal',     cb),
    onEngulfMonStatus: (cb) => on('engulf:monitorStatus', cb),
    onEngulfCheck:     (cb) => on('engulf:check',      cb),
    onFVGSignal:       (cb) => on('fvg:signal',        cb),
    onFVGMonStatus:    (cb) => on('fvg:monitorStatus', cb),
    onFVGCheck:        (cb) => on('fvg:check',         cb),
    onSFPSignal:       (cb) => on('sfp:signal',        cb),
    onSFPMonStatus:    (cb) => on('sfp:monitorStatus', cb),
    onSFPCheck:        (cb) => on('sfp:check',         cb),
    onPlaybookBSignal: (cb) => on('sfp:playbookB',     cb),
    onLondonLevels:    (cb) => on('london:levels',     cb),
    onNyLevels:        (cb) => on('ny:levels',         cb), // FIX 2026-07-27 — see ws-client.js case 'ny-levels' note
    onNewsStatus:      (cb) => on('news:status',       cb),
    onTradovateAccount:(cb) => on('tradovate:account',  cb),
    onTradovateTestResult:(cb)=> on('tradovate:testResult', cb),
    testTradovate:     ()   => rawSend({ type: 'tradovate-test' }),
    restartTradovate:  ()   => rawSend({ type: 'tradovate-restart' }),
    onNewsChartMarks:  (cb) => on('news:chartMarks',   cb),
    onMechanicalAnalysis: (cb) => on('mechanical:analysis', cb),
    onSessionAlert:    (cb) => on('session:alert',     cb),
    onWsOpen:          (cb) => on('ws:open',           cb),

    // Rules (rules.json on the server is the single source of truth)
    getRules:  () => sendRequest({ type: 'rules-get' }).then(r => r.data),
    setRules:  (data) => rawSend({ type: 'rules-set', data }),
    onRules:   (cb) => on('rules:data', cb),

    // Durable local data (data/ folder on disk — survives cache clears)
    dataSave: (key, payload) => sendRequest({ type: 'data-save', key, payload }).then(r => r.ok),
    dataLoad: (key)          => sendRequest({ type: 'data-load', key }).then(r => r.data),

    // PDF text extraction (server-side pdf-parse, for PDF uploads in Analyze CSV)
    pdfExtract: (base64) => sendRequest({ type: 'pdf-extract', base64 }).then(r => {
      if (!r.ok) throw new Error(r.error || 'PDF extraction failed');
      return r.text;
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

    removeAllListeners: () => { Object.keys(listeners).forEach(k => { listeners[k] = []; }); }
  };

  // Track MCP state
  on('mcp:connected',    () => { window._mcpConnected = true; });
  on('mcp:disconnected', () => { window._mcpConnected = false; });

  connect();
})();
