'use strict';
// ── Telegram bot bridge ──────────────────────────────────────────────────────
// Self-contained module: read-only requires from server.js's exports passed in
// via init(). Long-polling only (node-telegram-bot-api), no webhook/public URL.
//
// Security model: the bot is claimed by the first chat that messages it. Once
// `telegramChatId` is saved to config, every subsequent update is checked
// against that id — any other chat is silently ignored (no reply at all), so
// strangers who find the bot username get nothing back.
//
// KNOWN GAP: daily-loss-tier / pattern warnings currently live entirely in
// renderer/app.js (checkForPatternWarnings), client-side only. This module
// does NOT replicate that heuristic engine — it only pushes engulf-signal
// alerts, which already fire from a single server-side broadcast() call site
// in checkEngulfingSignal(). If Anoop wants daily-loss-tier warnings pushed to
// Telegram too, that logic needs to be ported server-side first; see the
// notify() method below, which is the only push entry point this module has.

let TelegramBot = null;
try {
  TelegramBot = require('node-telegram-bot-api');
} catch (e) {
  // Handled at start() — allows the app to boot even before `npm install`
  // has pulled this dependency in, matching the "must not throw" requirement.
}

const claudeAgent = require('./claude-agent');   // persona + tool schemas only (see _handleChat)
const groqAgent = require('./groq-agent');       // the shared multi-provider transport
const providerChain = require('./provider-chain');
const sessionMgr = require('./session-manager');

const TELEGRAM_MSG_LIMIT = 4096;

class TelegramBridge {
  constructor() {
    this.bot = null;
    this.cfg = null;          // cached config snapshot, refreshed on each message
    this.chatHistory = [];    // in-memory conversation history, resets on restart
    this.deps = null;         // injected from server.js: { loadConfig, saveConfig, getCurrentMode, setCurrentMode, broadcast, engulfMonitors, ENGULF_TFS, startEngulfMonitor, stopEngulfMonitor, checkEngulfingSignal }
  }

  // deps: object of functions/values from server.js so this module never has
  // to require('./server') (would be circular) — see wiring block in server.js.
  start(deps) {
    this.deps = deps;
    const cfg = deps.loadConfig();

    if (!TelegramBot) {
      console.log('⚠ Telegram bot: node-telegram-bot-api not installed — skipping (run npm install)');
      return;
    }

    if (!cfg.telegramBotToken) {
      console.log('⚠ Telegram bot: no token configured — skipping (set one in Settings)');
      return;
    }

    try {
      this.bot = new TelegramBot(cfg.telegramBotToken, { polling: true });
    } catch (e) {
      console.log('⚠ Telegram bot: failed to start —', e.message);
      this.bot = null;
      return;
    }

    this.bot.on('polling_error', (err) => {
      const msg = (err && err.message) || String(err);
      console.error('Telegram polling error:', msg);
      // A 404 here means Telegram rejected the bot token itself (revoked/regenerated
      // via BotFather, or never valid) — every retry will 404 forever, so stop
      // polling after the first one instead of spamming the console indefinitely.
      // Requires: paste a fresh token in Settings > Telegram Bot, then restart the app.
      if (!this._disabledForBadToken && /404/.test(msg)) {
        this._disabledForBadToken = true;
        console.error('⚠ Telegram bot: token rejected (404) — polling stopped. Update the token in Settings and restart the app to reconnect.');
        this.stop();
      }
    });

    this.bot.on('message', (msg) => this._handleMessage(msg).catch(err => {
      console.error('Telegram message handler error:', err.message);
    }));

    console.log('✓ Telegram bot: started (long-polling)');
  }

  stop() {
    if (this.bot) {
      try { this.bot.stopPolling(); } catch {}
      this.bot = null;
    }
  }

  // Push a plain text notification to the linked chat. No-op (silent) if no
  // chat has claimed the bot yet, or if the bot isn't running.
  notify(text) {
    if (!this.bot || !this.deps) return;
    const cfg = this.deps.loadConfig();
    if (!cfg.telegramChatId) return;
    this._sendChunked(cfg.telegramChatId, text).catch(err => {
      console.error('Telegram notify error:', err.message);
    });
  }

  // 2026-08-17: push a chart screenshot alongside a GO verdict — much faster
  // to eyeball on a phone than reading a paragraph. Fails soft to a
  // text-only notify() if the photo send fails for any reason (bad path,
  // Telegram API error) — a GO alert must never go completely missing just
  // because the screenshot step had a problem.
  notifyPhoto(photoPath, caption) {
    if (!this.bot || !this.deps) return;
    const cfg = this.deps.loadConfig();
    if (!cfg.telegramChatId) return;
    this.bot.sendPhoto(cfg.telegramChatId, photoPath, { caption: (caption || '').slice(0, 1024) })
      .catch((err) => {
        console.error('Telegram notifyPhoto error, falling back to text:', err.message);
        this.notify(caption || '(GO verdict — screenshot failed to send)');
      });
  }

  // ── Internal ────────────────────────────────────────────────────────────
  async _sendChunked(chatId, text) {
    if (!this.bot) return;
    if (!text) return;
    for (let i = 0; i < text.length; i += TELEGRAM_MSG_LIMIT) {
      const chunk = text.slice(i, i + TELEGRAM_MSG_LIMIT);
      await this.bot.sendMessage(chatId, chunk);
    }
  }

  async _handleMessage(msg) {
    const { loadConfig, saveConfig } = this.deps;
    const cfg = loadConfig();
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    // ── Claim-on-first-message bootstrap ─────────────────────────────────
    if (!cfg.telegramChatId) {
      cfg.telegramChatId = chatId;
      saveConfig(cfg);
      await this._sendChunked(chatId, 'Linked. This bot will only respond in this chat from now on.');
      console.log(`✓ Telegram bot: linked to chat id ${chatId}`);
      return;
    }

    // ── Reject any chat other than the linked one — silently, no reply ──
    // eslint-disable-next-line eqeqeq
    if (String(cfg.telegramChatId) !== String(chatId)) {
      return;
    }

    if (!text) return;

    if (text.startsWith('/')) {
      await this._handleCommand(chatId, text, cfg);
    } else {
      await this._handleChat(chatId, text);
    }
  }

  async _handleCommand(chatId, text, cfg) {
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase().split('@')[0]; // strip @BotName suffix
    const args = parts.slice(1);

    switch (cmd) {
      case '/status':    return this._cmdStatus(chatId, cfg);
      case '/mode':      return this._cmdMode(chatId, args);
      case '/engulf':    return this._cmdEngulf(chatId, args);
      case '/check':     return this._cmdCheck(chatId, args);
      case '/playbookb': return this._cmdPlaybookB(chatId, args);
      case '/rules':     return this._cmdRules(chatId, cfg);
      case '/trade':     return this._cmdTrade(chatId, args);
      case '/help':      return this._cmdHelp(chatId);
      case '/start':   return this._sendChunked(chatId, 'Co-Pilot bot is linked and ready. /help for commands.');
      default:
        return this._sendChunked(chatId, 'Unknown command. /help for the list.');
    }
  }

  // ── /status ─────────────────────────────────────────────────────────────
  _cmdStatus(chatId, cfg) {
    const mode = this.deps.getCurrentMode();
    const balance   = cfg.balance !== undefined ? cfg.balance : 50000;
    const profit    = cfg.profit !== undefined ? cfg.profit : 0;
    const fundedFloor     = cfg.fundedFloor     !== undefined ? cfg.fundedFloor     : 48000;
    const evalFloor        = cfg.evalFloor       !== undefined ? cfg.evalFloor       : 49364;
    const evalDayCap        = cfg.evalDayCap      !== undefined ? cfg.evalDayCap      : 1499;
    const evalDayStop       = cfg.evalDayStop     !== undefined ? cfg.evalDayStop     : 400;
    const fundedDayStop     = cfg.fundedDayStop   !== undefined ? cfg.fundedDayStop   : 200;
    const fundedTargetMin   = cfg.fundedTargetMin !== undefined ? cfg.fundedTargetMin : 150;
    const fundedTargetMax   = cfg.fundedTargetMax !== undefined ? cfg.fundedTargetMax : 300;
    const payoutTarget      = cfg.payoutTarget    !== undefined ? cfg.payoutTarget    : 52000;

    const floor  = mode === 'eval' ? evalFloor : fundedFloor;
    const buffer = balance - floor;

    let goNoGo = 'GO';
    const reasons = [];
    if (mode === 'eval' && profit <= -evalDayStop) { goNoGo = 'NO-GO'; reasons.push(`eval day stop -$${evalDayStop} hit`); }
    if (mode === 'funded' && profit <= -fundedDayStop) { goNoGo = 'NO-GO'; reasons.push(`funded hard stop -$${fundedDayStop} hit`); }
    if (mode === 'funded' && profit <= -150 && profit > -fundedDayStop) reasons.push('RED — $150 down, A+ setups only');
    else if (mode === 'funded' && profit <= -100 && profit > -150) reasons.push('YELLOW — $100 down, reassess');

    const lines = [
      `MODE: ${mode.toUpperCase()}`,
      `Balance: $${Number(balance).toLocaleString()}`,
      `Floor: $${Number(floor).toLocaleString()} | Buffer: $${Number(buffer).toLocaleString()}`,
      `Today's P&L: $${profit}`,
      mode === 'eval'
        ? `Day cap: $${evalDayCap} | Day stop: -$${evalDayStop}`
        : `Target: $${fundedTargetMin}-$${fundedTargetMax} | Day stop: -$${fundedDayStop} | Payout target balance: $${Number(payoutTarget).toLocaleString()}`,
      `Verdict: ${goNoGo}${reasons.length ? ' — ' + reasons.join('; ') : ''}`
    ];
    return this._sendChunked(chatId, lines.join('\n'));
  }

  // ── /mode eval|funded ──────────────────────────────────────────────────
  _cmdMode(chatId, args) {
    const m = (args[0] || '').toLowerCase();
    if (m !== 'eval' && m !== 'funded') {
      return this._sendChunked(chatId, 'Usage: /mode eval  or  /mode funded');
    }
    this.deps.setCurrentMode(m);
    return this._sendChunked(chatId, `Mode switched to ${m.toUpperCase()}.`);
  }

  // ── /engulf <1h|30m|15m> <on|off> ──────────────────────────────────────
  _cmdEngulf(chatId, args) {
    const tf = (args[0] || '').toLowerCase();
    const state = (args[1] || '').toLowerCase();
    const { ENGULF_TFS, startEngulfMonitor, stopEngulfMonitor } = this.deps;

    if (!ENGULF_TFS[tf]) {
      return this._sendChunked(chatId, 'Usage: /engulf <1h|30m|15m> <on|off>');
    }
    if (state !== 'on' && state !== 'off') {
      return this._sendChunked(chatId, 'Usage: /engulf <1h|30m|15m> <on|off>');
    }

    if (state === 'on') {
      startEngulfMonitor(tf);
      return this._sendChunked(chatId, `${ENGULF_TFS[tf].label} engulf monitor turned ON.`);
    }
    // 1.2 (decision 2): watchers are always on — 'off' is refused, never honoured.
    return this._sendChunked(chatId, `${ENGULF_TFS[tf].label} engulf watcher is always on — 'off' is not supported.`);
  }

  // ── /check <1h|30m|15m> ─────────────────────────────────────────────────
  async _cmdCheck(chatId, args) {
    const tf = (args[0] || '').toLowerCase();
    const { ENGULF_TFS, checkEngulfingSignal, engulfMonitors } = this.deps;
    if (!ENGULF_TFS[tf]) {
      return this._sendChunked(chatId, 'Usage: /check <1h|30m|15m>');
    }
    await this._sendChunked(chatId, `Checking ${ENGULF_TFS[tf].label}…`);
    await checkEngulfingSignal(tf);
    const mon = engulfMonitors[tf];
    if (mon && mon.lastSignalKey) {
      return this._sendChunked(chatId, `${ENGULF_TFS[tf].label}: last signal bucket ${mon.lastSignalKey}. Check the app for full detail — result also broadcast to browser.`);
    }
    return this._sendChunked(chatId, `${ENGULF_TFS[tf].label}: no signal found.`);
  }

  // ── /playbookb on|off — SFP liquidity-raid + confirming FVG monitor ─────
  _cmdPlaybookB(chatId, args) {
    const state = (args[0] || '').toLowerCase();
    const { startSFPMonitor, stopSFPMonitor, sfpMonitors } = this.deps;
    if (!startSFPMonitor || !sfpMonitors) {
      return this._sendChunked(chatId, 'Playbook B monitor not available on this build — restart the app.');
    }
    if (state !== 'on' && state !== 'off') {
      const running = sfpMonitors['30m'] && sfpMonitors['30m'].running;
      const pending = sfpMonitors['30m'] && sfpMonitors['30m'].pending;
      return this._sendChunked(chatId,
        `Usage: /playbookb on|off\nCurrent: ${running ? 'ON' : 'OFF'}${pending ? ' — liquidity raid pending, awaiting displacement FVG' : ''}`
      );
    }
    if (state === 'on') {
      startSFPMonitor('30m');
      return this._sendChunked(chatId, `Playbook B monitor (30M) turned ON.`);
    }
    // 1.2 (decision 2): watchers are always on — 'off' is refused, never honoured.
    return this._sendChunked(chatId, `Playbook B monitor (30M) is always on — 'off' is not supported.`);
  }

  // ── /rules ──────────────────────────────────────────────────────────────
  _cmdRules(chatId, cfg) {
    const mode = this.deps.getCurrentMode();
    const summary = mode === 'eval'
      ? [
          'EVAL RULES (summary):',
          '- Profit target $3,000 (balance to $53,000)',
          '- Max Loss Limit $2,000 EOD trailing, locks at $50,100 once balance > $52,100',
          '- Consistency: best day <= 50% of total P&L, hard cap $1,499/day',
          '- Personal daily stop -$400',
          '- Max size 40 micros | Max trades: 3/session, 5/day',
          '- 15-min break mandatory after every trade'
        ]
      : [
          'FUNDED RULES (summary):',
          '- Daily loss tiers: -$100 YELLOW / -$150 RED / -$200 HARD STOP',
          '- Daily target $150-$300, consider stopping at $300',
          '- Max 2 contracts per entry, max 20 trades/day',
          '- One instrument per day (never MNQ + MGC same day)',
          '- Sessions: London 1:30-3:00PM IST (prep/small) + NY 7:00-9:00PM IST (primary)',
          '- 15-min break mandatory after every trade',
          '- Pre-marked 4H zones mandatory before session'
        ];
    return this._sendChunked(chatId, summary.join('\n'));
  }

  // ── /trade long 21050 21030 21090 -50 ─────────────────────────────────
  // format: /trade <direction> <entry> <stop> <target> <pnl> [exit]
  _cmdTrade(chatId, args) {
    if (args.length < 4) {
      return this._sendChunked(chatId,
        'Usage: /trade <long|short> <entry> <stop> <target> <pnl> [exit]\n' +
        'Example: /trade long 21050 21030 21090 -50'
      );
    }
    const [directionRaw, entryRaw, stopRaw, targetRaw, pnlRaw, exitRaw] = args;
    const direction = directionRaw.toLowerCase();
    if (direction !== 'long' && direction !== 'short') {
      return this._sendChunked(chatId, 'Direction must be "long" or "short". Usage: /trade <long|short> <entry> <stop> <target> <pnl> [exit]');
    }
    const entry  = parseFloat(entryRaw);
    const stop   = parseFloat(stopRaw);
    const target = parseFloat(targetRaw);
    const pnl    = parseFloat(pnlRaw);
    const exit   = exitRaw !== undefined ? parseFloat(exitRaw) : undefined;

    if ([entry, stop, target, pnl].some(v => isNaN(v))) {
      return this._sendChunked(chatId, 'Entry, stop, target, and pnl must all be numbers. Usage: /trade <long|short> <entry> <stop> <target> <pnl> [exit]');
    }

    const time = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    const trade = {
      time,
      direction: direction === 'long' ? 'Long' : 'Short',
      entry, stop, target,
      exit: exit !== undefined && !isNaN(exit) ? exit : undefined,
      pnl,
      breakTaken: false,
      notes: 'logged via Telegram'
    };

    const result = sessionMgr.logTrade(sessionMgr.todayStr(), trade);
    if (this.deps.broadcast) {
      this.deps.broadcast({ type: 'session-trade-logged', reqId: null, data: result });
    }
    return this._sendChunked(chatId, `Logged trade #${result.num} to ${sessionMgr.todayStr()}.md (${trade.direction} ${entry} -> SL ${stop} / TP ${target}, P&L $${pnl}).`);
  }

  // ── /help ───────────────────────────────────────────────────────────────
  _cmdHelp(chatId) {
    const lines = [
      'Commands:',
      '/status - balance, floor, buffer, P&L, GO/NO-GO',
      '/mode eval|funded - switch account mode',
      '/engulf <1h|30m|15m> on - engulf watchers are always on (off not supported)',
      '/check <1h|30m|15m> - run an engulf check now',
      '/playbookb on - Playbook B watcher is always on (off not supported)',
      '/rules - current mode rule summary',
      '/trade <long|short> <entry> <stop> <target> <pnl> [exit] - log a trade',
      '/help - this list',
      '',
      'Anything else (no leading /) is sent to the AI co-pilot.'
    ];
    return this._sendChunked(chatId, lines.join('\n'));
  }

  // Mirrors renderer/app.js's buildContextMessage() — the browser prepends this
  // fresh before every send so the AI always has live account state. The
  // Telegram side needs the same thing or the AI is answering blind on mode,
  // balance, floor/buffer and today's P&L. Trade count is read from today's
  // session markdown file (same row-count approach session-manager.js's
  // logTrade uses internally) since it isn't in config. GO/NO-GO isn't
  // reconstructable server-side (it's set via the pre-session check flow,
  // which is browser-only) — omitted rather than faked.
  _buildContextMessage() {
    const cfg = this.deps.loadConfig();
    const mode = this.deps.getCurrentMode();
    const balance = cfg.balance !== undefined ? cfg.balance : 50000;
    const profit  = cfg.profit !== undefined ? cfg.profit : 0;
    const fundedFloor   = cfg.fundedFloor   !== undefined ? cfg.fundedFloor   : 48000;
    const evalFloor      = cfg.evalFloor     !== undefined ? cfg.evalFloor     : 49364;
    const evalDayCap      = cfg.evalDayCap    !== undefined ? cfg.evalDayCap    : 1499;
    const evalDayStop     = cfg.evalDayStop   !== undefined ? cfg.evalDayStop   : 400;
    const fundedDayStop   = cfg.fundedDayStop !== undefined ? cfg.fundedDayStop : 200;
    const fundedTargetMin = cfg.fundedTargetMin !== undefined ? cfg.fundedTargetMin : 150;
    const fundedTargetMax = cfg.fundedTargetMax !== undefined ? cfg.fundedTargetMax : 300;
    const floor  = mode === 'eval' ? evalFloor : fundedFloor;
    const buffer = balance - floor;

    let tradeCount = 0;
    try {
      const content = sessionMgr.readSession(sessionMgr.todayStr());
      if (content) tradeCount = (content.match(/^\|\s*\d+\s*\|/gm) || []).length;
    } catch {}

    const size = mode === 'eval'
      ? '40 micros'
      : (profit >= 2000 ? '40 micros' : profit >= 1000 ? '30 micros' : '20 micros');

    const modeRules = mode === 'eval'
      ? `Daily stop: -$${evalDayStop} | Day cap: $${evalDayCap} | Max size: 40 micros | Session trades: 3 | Daily: 5`
      : `Daily loss tiers: -$100 YELLOW / -$150 RED / -$${fundedDayStop} HARD STOP | Target: $${fundedTargetMin}-$${fundedTargetMax} | Size: ${size} | Trades: ${tradeCount}/20 | 15-min break mandatory | One instrument per DAY`;

    return {
      role: 'user',
      content: `[LIVE SESSION (via Telegram) — ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST | MODE: ${mode.toUpperCase()}]
Balance: $${balance.toLocaleString()} | Floor: $${floor.toLocaleString()} | Buffer: $${buffer.toLocaleString()}
Today P&L: ${profit >= 0 ? '+' : ''}$${profit} | Trades today: ${tradeCount}
${modeRules}
[END CONTEXT — respond concisely]`
    };
  }

  // ── Free-text chat → AI co-pilot ──────────────────────────────────────
  async _handleChat(chatId, text) {
    this.chatHistory.push({ role: 'user', content: text });
    // Keep history bounded so we don't grow unbounded in memory over a long session.
    if (this.chatHistory.length > 40) this.chatHistory = this.chatHistory.slice(-40);

    const mode = this.deps.getCurrentMode();
    const messages = [this._buildContextMessage(), ...this.chatHistory];

    // 2026-09-02: repointed off claudeAgent.stream() onto the same
    // groqAgent.stream() + primaryProviderModel() path every other agent in
    // this app uses, so DeepSeek serves this call site too.
    //
    // WHY REPOINT A FEATURE ANOOP DOESN'T USE, INSTEAD OF DELETING IT
    // This was the ninth AI call site and the last thing in the app still
    // reaching Anthropic directly through the SDK — every other agent had
    // already moved to the shared transport. Left alone it would have kept the
    // whole @anthropic-ai/sdk dependency alive purely to serve a bridge with
    // no bot token configured, and it would have silently stayed on a provider
    // the rest of the app had abandoned. Repointing is a handful of lines and
    // means "everything runs on one API" is literally true rather than nearly.
    //
    // STILL DORMANT, AND THEREFORE UNVERIFIED: `telegramBotToken` is blank in
    // Anoop's config, so start() never builds a bot and this function is
    // unreachable. That means this path is NOT covered by the Landing 1 smoke
    // test — nothing exercises it. Treat it as untested until a token exists.
    //
    // claude-agent.js is still required above, but only for its persona and
    // tool schemas via _debug — exactly how handleChat in server.js uses it —
    // so there remains one copy of the Claude-path prompt in the codebase.
    // Tool shape is converted Anthropic -> OpenAI here for the same reason it
    // is in handleChat. No toolExecutor is passed, so groq-agent defaults to
    // the TV MCP bridge, which is what claudeAgent.stream() did too.
    const systemPrompt = claudeAgent._debug.buildSystemPrompt(mode);
    const chatTools = claudeAgent._debug.ALL_TOOLS.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema }
    }));
    const primary = providerChain.primaryProviderModel(this.cfg || {}, false);

    await new Promise((resolve) => {
      let fullText = '';
      groqAgent.stream(messages, systemPrompt, chatTools, {
        provider: primary.provider,
        model: primary.model,
        fallbackChain: providerChain.fallbackChainFor(primary),
        onToken: () => {}, // Telegram isn't a token-streaming UI — send once on completion
        onToolStart: () => {},
        onToolDone: () => {},
        onDone: async (text) => {
          fullText = text;
          this.chatHistory.push({ role: 'assistant', content: fullText });
          await this._sendChunked(chatId, fullText || '(no response)');
          resolve();
        },
        onError: async (errMsg) => {
          await this._sendChunked(chatId, `Error: ${errMsg}`);
          resolve();
        }
      });
    });
  }
}

const bridge = new TelegramBridge();
module.exports = bridge;
