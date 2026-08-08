'use strict';
const { spawn } = require('child_process');
const EventEmitter = require('events');

const MCP_SERVER_PATH = 'G:\\MNQ-CoPilot\\tradingview-mcp\\src\\server.js';

// How often to verify TradingView's CDP connection is actually alive, not just
// that this bridge's child process is up. Fixed 2026-07-15: `ready` only ever
// reflected the bridge's own JSON-RPC handshake with its child MCP process —
// it stayed true even after TradingView desktop itself crashed, which is why
// the app's "TradingView connected" indicator kept showing green while every
// level-marking call failed with "no bar data available yet". This heartbeat
// gives a real, continuously-verified signal (tvConnected) instead.
const HEARTBEAT_MS = 30 * 1000;
// After a relaunch, give TradingView time to boot + re-attach CDP before
// re-checking health. FIX 2026-07-17: was 8s — a TradingView cold start takes
// 20-60s, so recovery always "failed" and re-fired every heartbeat.
const RECOVERY_WAIT_MS = 25 * 1000;
// tv_launch itself must be allowed to run far longer than a normal tool call.
const LAUNCH_TIMEOUT_MS = 90 * 1000;
const HEALTH_TIMEOUT_MS = 20 * 1000;
// Backoff cap for auto-restarting the bridge's own child process if IT dies
// (separate from TradingView dying — see tv-recovery handling below).
const MAX_BRIDGE_RESTART_BACKOFF_MS = 30 * 1000;

class MCPBridge extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buf = '';
    this.ready = false;        // bridge child process is up + handshake done
    this.tvConnected = false;  // TradingView CDP verified reachable (heartbeat)
    this._heartbeatTimer = null;
    this._recovering = false;
    this._bridgeRestartAttempts = 0;
    this._intentionalStop = false;
  }

  async start() {
    this._intentionalStop = false;
    return new Promise((resolve, reject) => {
      this.proc = spawn('node', [MCP_SERVER_PATH], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
      });

      this.proc.stdout.on('data', (chunk) => {
        this.buf += chunk.toString();
        let nl;
        while ((nl = this.buf.indexOf('\n')) !== -1) {
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (line) this._handleLine(line);
        }
      });

      this.proc.stderr.on('data', (d) => {
        const msg = d.toString();
        if (msg.includes('listening') || msg.includes('ready') || msg.includes('MCP')) {
          this.emit('status', msg.trim());
        }
      });

      this.proc.on('exit', (code) => {
        this.ready = false;
        this.tvConnected = false;
        this._stopHeartbeat();
        this.emit('disconnected', code);
        // Reject all pending requests
        for (const [, p] of this.pending) {
          p.reject(new Error('MCP process exited'));
        }
        this.pending.clear();

        // Auto-restart the bridge's own child process if it died unexpectedly
        // (not via our own stop()). This is distinct from TradingView crashing
        // underneath a still-alive bridge — that case is handled by the
        // heartbeat/_attemptTVRecovery path instead.
        if (!this._intentionalStop) {
          this._scheduleBridgeRestart();
        }
      });

      this.proc.on('error', (err) => {
        reject(err);
      });

      // Give the process a moment to start, then initialize
      setTimeout(async () => {
        try {
          await this._initialize();
          this._bridgeRestartAttempts = 0;
          resolve();
        } catch (e) {
          reject(e);
        }
      }, 1500);
    });
  }

  _scheduleBridgeRestart() {
    this._bridgeRestartAttempts++;
    const delay = Math.min(3000 * this._bridgeRestartAttempts, MAX_BRIDGE_RESTART_BACKOFF_MS);
    this.emit('status', `Bridge process exited unexpectedly — restarting in ${Math.round(delay / 1000)}s (attempt ${this._bridgeRestartAttempts})`);
    setTimeout(() => {
      this.start().catch((e) => {
        this.emit('status', 'Bridge restart failed: ' + e.message);
        // start() failing rejects the promise but the exit handler above
        // won't fire again on its own here, so keep the retry loop alive.
        this._scheduleBridgeRestart();
      });
    }, delay);
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => this._checkTVHealth(), HEARTBEAT_MS);
    this._checkTVHealth(); // don't wait a full interval for the first read
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  _parseResult(res) {
    try {
      const raw = res && res.content && res.content[0] && res.content[0].text;
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async _checkTVHealth() {
    if (!this.ready) return;
    let connected = false;
    let detail = null;
    try {
      const res = await this.callTool('tv_health_check', {}, HEALTH_TIMEOUT_MS);
      const parsed = this._parseResult(res);
      connected = !!(parsed && parsed.cdp_connected);
      if (!connected) detail = (parsed && parsed.error) || 'CDP not connected';
    } catch (e) {
      detail = e.message;
    }

    const wasConnected = this.tvConnected;
    this.tvConnected = connected;

    if (connected) {
      if (!wasConnected) this.emit('tv-connected');
    } else {
      if (wasConnected) this.emit('tv-disconnected', detail);
      if (!this._recovering) this._attemptTVRecovery(detail);
    }
  }

  // TradingView desktop (a separate Windows Store app, not this bridge
  // process) is prone to being killed by the OS or by its own auto-update —
  // see CLAUDE.md notes on this. Rather than requiring a manual tv_launch +
  // server restart every time, ask the underlying MCP server to relaunch it
  // and re-verify, automatically, on every heartbeat that finds it down.
  async _attemptTVRecovery(detail) {
    // SAFETY (2026-07-17): tv_launch KILLS TradingView.exe before relaunching
    // with the CDP flag. Never do that during the trader's live trading window
    // (18:45–21:15 IST buffer around the 19:00–21:00 session) — closing his
    // charts mid-position is worse than a dead co-pilot connection.
    const istMin = (() => {
      const n = new Date();
      const utc = n.getUTCHours() * 60 + n.getUTCMinutes();
      return (utc + 330) % 1440; // IST = UTC+5:30
    })();
    const inSessionWindow = (istMin >= 18 * 60 + 45 && istMin < 21 * 60 + 15);

    // FIX 2026-07-29 (the trader: "i dont [want to] report tv_health connect
    // everyday after opening the app"). The old code returned outright inside
    // the session window, which meant auto-recovery was disabled at exactly
    // the time he most needs it — he opens the app around the NY session, so
    // in practice it NEVER self-healed and he had to ask me every day.
    //
    // The safety concern was real but too broad: tv_launch defaults to
    // kill_existing=true, which closes his charts mid-position. But
    // kill_existing=false only *starts* TradingView if it isn't running — it
    // cannot close anything. That's safe in any window. So:
    //   - outside the session → full relaunch (kill + restart with CDP)
    //   - inside the session  → non-destructive launch only
    // If TradingView is already running WITHOUT CDP during a session, we still
    // won't kill it — we say so explicitly instead of silently doing nothing.
    this._recovering = true;
    this.emit('status', inSessionWindow
      ? `TradingView unreachable (${detail || 'unknown'}) — inside your session window, trying a SAFE start (will not close existing charts)…`
      : `TradingView unreachable (${detail || 'unknown'}) — relaunching (allow up to 2 min)…`);
    try {
      await this.callTool('tv_launch', inSessionWindow ? { kill_existing: false } : {}, LAUNCH_TIMEOUT_MS);
      await new Promise((r) => setTimeout(r, RECOVERY_WAIT_MS));
      // TV may still be loading the chart — poll health a few times before
      // declaring failure instead of giving up on the first read.
      let ok = false;
      for (let i = 0; i < 4 && !ok; i++) {
        try {
          const res = await this.callTool('tv_health_check', {}, HEALTH_TIMEOUT_MS);
          const parsed = this._parseResult(res);
          ok = !!(parsed && parsed.cdp_connected);
        } catch (e) { /* keep polling */ }
        if (!ok) await new Promise((r) => setTimeout(r, 10000));
      }
      this.tvConnected = ok;
      if (ok) {
        this.emit('tv-connected');
        this.emit('status', inSessionWindow
          ? 'TradingView connected (safe start — your charts were not touched).'
          : 'TradingView relaunched and reconnected.');
      } else if (inSessionWindow) {
        // Non-destructive start didn't help: TradingView is almost certainly
        // already running but was started WITHOUT the CDP debugging flag. We
        // deliberately will not kill it mid-session — tell him precisely what
        // to do instead of leaving a silent red dot.
        this.emit('status', 'TradingView is open but without the debug connection, and I will NOT close it mid-session. Close TradingView yourself and reopen it via the "Launch TradingView for Claude" shortcut, or wait until after 21:15 IST for an automatic fix.');
      } else {
        this.emit('status', 'TradingView relaunch attempted but still not connected — will retry on next heartbeat.');
      }
    } catch (e) {
      this.emit('status', 'TradingView auto-relaunch failed: ' + e.message + ' — will retry on next heartbeat.');
    } finally {
      this._recovering = false;
    }
  }

  _handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // Not JSON, ignore (could be debug output)
    }

    // Response to a request
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) {
        reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        resolve(msg.result);
      }
    }
  }

  _rpc(method, params, timeoutMs) {
    // FIX 2026-07-17: the fixed 12s timeout was the root cause of the eternal
    // "auto-relaunch failed: MCP timeout" — slow calls (tv_launch, first health
    // check while TV boots) need their own budget.
    const budget = timeoutMs || 12000;
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.exitCode !== null) {
        return reject(new Error('MCP not running'));
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });

      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      this.proc.stdin.write(msg);

      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP timeout (${Math.round(budget / 1000)}s): ${method}`));
        }
      }, budget);

      // Clear timer on resolution
      const origResolve = resolve;
      const origReject = reject;
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); origResolve(v); },
        reject: (e) => { clearTimeout(timer); origReject(e); }
      });
    });
  }

  async _initialize() {
    const result = await this._rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { roots: {}, sampling: {} },
      clientInfo: { name: 'mnq-copilot', version: '1.0.0' }
    });
    // Acknowledge
    this.proc.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n'
    );
    this.ready = true;
    this.emit('connected', result);
    this._startHeartbeat();
    return result;
  }

  async callTool(name, args, timeoutMs) {
    if (!this.ready) throw new Error('MCP not connected to TradingView');
    const result = await this._rpc('tools/call', { name, arguments: args || {} }, timeoutMs);
    return result;
  }

  async listTools() {
    const result = await this._rpc('tools/list', {});
    return result ? (result.tools || []) : [];
  }

  async healthCheck() {
    try {
      const r = await this.callTool('tv_health_check', {});
      return { ok: true, data: r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  stop() {
    this._intentionalStop = true;
    this._stopHeartbeat();
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
      this.ready = false;
      this.tvConnected = false;
    }
  }
}

module.exports = new MCPBridge();
