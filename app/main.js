'use strict';
const { app, BrowserWindow, ipcMain, nativeTheme, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const mcpBridge = require('./mcp-bridge');
const claudeAgent = require('./claude-agent');
const sessionMgr = require('./session-manager');
const supercompress = require('./supercompress');

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const WINDOW_STATE_PATH = path.join(app.getPath('userData'), 'window-state.json');

// ── Config helpers ─────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

// ── Window position/size persistence ────────────────────────────────────────────
// 2026-07-28: the trader asked the app to reopen on whatever screen/size he last
// closed it at, instead of always launching at a fixed 1500x940 on the
// primary display. Bounds (x, y, width, height) + maximized flag are saved on
// every move/resize (debounced) and on close, then restored on next launch —
// clamped against CURRENTLY connected displays so a bad restore (e.g. a
// monitor unplugged since last run) can't put the window off-screen.
function loadWindowState() {
  try { return JSON.parse(fs.readFileSync(WINDOW_STATE_PATH, 'utf8')); }
  catch { return null; }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const isMaximized = mainWindow.isMaximized();
    // getBounds() while maximized returns the maximized bounds, not the
    // restored ones — capture normal bounds via getNormalBounds() so
    // un-maximizing later restores to the pre-maximize size/position.
    const bounds = typeof mainWindow.getNormalBounds === 'function'
      ? mainWindow.getNormalBounds()
      : mainWindow.getBounds();
    fs.writeFileSync(WINDOW_STATE_PATH, JSON.stringify({ ...bounds, isMaximized }, null, 2), 'utf8');
  } catch (e) { /* non-fatal — just means next launch uses defaults */ }
}

// Debounced save — move/resize fire rapidly while dragging.
let saveStateTimer = null;
function scheduleSaveWindowState() {
  clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(saveWindowState, 400);
}

// Clamp saved bounds to a currently-connected display so the window can't
// restore fully or partially off-screen after a monitor is unplugged/moved.
function clampBoundsToDisplays(bounds) {
  const displays = screen.getAllDisplays();
  const fitsAny = displays.some(d => {
    const a = d.workArea;
    return bounds.x >= a.x - 50 && bounds.y >= a.y - 50 &&
           bounds.x + bounds.width  <= a.x + a.width  + 50 &&
           bounds.y + bounds.height <= a.y + a.height + 50;
  });
  if (fitsAny) return bounds;
  // Doesn't fit on any connected display — fall back to centering on the
  // primary display at the saved size (keeps size preference, fixes position).
  const primary = screen.getPrimaryDisplay().workArea;
  const width = Math.min(bounds.width || 1500, primary.width);
  const height = Math.min(bounds.height || 940, primary.height);
  return {
    x: primary.x + Math.round((primary.width - width) / 2),
    y: primary.y + Math.round((primary.height - height) / 2),
    width, height
  };
}

// ── Main window ────────────────────────────────────────────────────────────────
let mainWindow;

function createWindow() {
  nativeTheme.themeSource = 'dark';

  const saved = loadWindowState();
  const defaults = { width: 1500, height: 940 };
  const restored = saved ? clampBoundsToDisplays({
    x: saved.x, y: saved.y,
    width: saved.width || defaults.width,
    height: saved.height || defaults.height
  }) : defaults;

  mainWindow = new BrowserWindow({
    x: restored.x,
    y: restored.y,
    width: restored.width,
    height: restored.height,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0a0a0a',
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#111111',
      symbolColor: '#888888',
      height: 32
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    icon: fs.existsSync(path.join(__dirname, 'icon.png')) ? path.join(__dirname, 'icon.png') : undefined
  });

  if (saved && saved.isMaximized) mainWindow.maximize();

  mainWindow.on('move',   scheduleSaveWindowState);
  mainWindow.on('resize', scheduleSaveWindowState);
  mainWindow.on('close',  saveWindowState);

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Initialise API key from config
  const cfg = loadConfig();
  if (cfg.apiKey) {
    claudeAgent.init(cfg.apiKey);
  }
  if (cfg.supercompressApiKey) {
    supercompress.init(cfg.supercompressApiKey);
  }

  // Start MCP bridge
  startMCP();
}

async function startMCP() {
  try {
    mcpBridge.on('status', (msg) => {
      if (mainWindow) mainWindow.webContents.send('mcp:status-update', msg);
    });
    mcpBridge.on('connected', () => {
      if (mainWindow) mainWindow.webContents.send('mcp:connected');
    });
    mcpBridge.on('disconnected', () => {
      if (mainWindow) mainWindow.webContents.send('mcp:disconnected');
    });

    await mcpBridge.start();
  } catch (err) {
    console.error('MCP start error:', err.message);
    // Non-fatal — app works without TradingView connection
    if (mainWindow) {
      mainWindow.webContents.send('mcp:status-update', 'TradingView MCP offline: ' + err.message);
    }
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  mcpBridge.stop();
  app.quit();
});

// ── IPC: Config ────────────────────────────────────────────────────────────────
ipcMain.handle('config:get', (_, key) => {
  const cfg = loadConfig();
  return key ? cfg[key] : cfg;
});

ipcMain.handle('config:set', (_, key, val) => {
  const cfg = loadConfig();
  cfg[key] = val;
  saveConfig(cfg);
  if (key === 'apiKey') {
    claudeAgent.init(val);
  }
  if (key === 'supercompressApiKey') {
    supercompress.init(val);
  }
  return true;
});

// ── IPC: Chat (Claude API streaming) ──────────────────────────────────────────
ipcMain.handle('chat:send', async (event, messages) => {
  const sender = event.sender;

  await claudeAgent.stream(messages, {
    onToken: (text) => {
      if (!sender.isDestroyed()) sender.send('chat:token', text);
    },
    onToolStart: (name, id) => {
      if (!sender.isDestroyed()) sender.send('chat:tool-start', name, id);
    },
    onToolDone: (name, id, ok, result) => {
      if (!sender.isDestroyed()) sender.send('chat:tool-done', name, id, ok, result);
    },
    onDone: (fullText) => {
      if (!sender.isDestroyed()) sender.send('chat:done', fullText);
    },
    onError: (msg) => {
      if (!sender.isDestroyed()) sender.send('chat:error', msg);
    }
  });

  return true;
});

// ── IPC: MCP direct calls ──────────────────────────────────────────────────────
ipcMain.handle('mcp:call', async (_, name, args) => {
  try {
    const result = await mcpBridge.callTool(name, args || {});
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mcp:status', () => {
  return { connected: mcpBridge.ready };
});

// ── IPC: Sessions ──────────────────────────────────────────────────────────────
ipcMain.handle('session:start', (_, data) => {
  return sessionMgr.startSession(sessionMgr.todayStr(), data || {});
});

ipcMain.handle('session:trade', (_, trade) => {
  return sessionMgr.logTrade(sessionMgr.todayStr(), trade);
});

ipcMain.handle('session:read', (_, date) => {
  return sessionMgr.readSession(date);
});

ipcMain.handle('session:list', () => {
  return sessionMgr.listSessions();
});

// ── IPC: Screenshots ───────────────────────────────────────────────────────────
ipcMain.handle('screenshot:get', (_, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const data = fs.readFileSync(filePath);
    return 'data:image/png;base64,' + data.toString('base64');
  } catch {
    return null;
  }
});
