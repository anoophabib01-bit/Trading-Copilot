'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Config
  getConfig: (key) => ipcRenderer.invoke('config:get', key),
  setConfig: (key, val) => ipcRenderer.invoke('config:set', key, val),

  // Chat
  sendChat: (messages) => ipcRenderer.invoke('chat:send', messages),
  onChatToken: (cb) => {
    ipcRenderer.on('chat:token', (_, text) => cb(text));
  },
  onChatToolStart: (cb) => {
    ipcRenderer.on('chat:tool-start', (_, name, id) => cb(name, id));
  },
  onChatToolDone: (cb) => {
    ipcRenderer.on('chat:tool-done', (_, name, id, ok, result) => cb(name, id, ok, result));
  },
  onChatDone: (cb) => {
    ipcRenderer.on('chat:done', (_, text) => cb(text));
  },
  onChatError: (cb) => {
    ipcRenderer.on('chat:error', (_, msg) => cb(msg));
  },

  // MCP direct calls (for quick UI actions)
  mcpCall: (name, args) => ipcRenderer.invoke('mcp:call', name, args),
  getMcpStatus: () => ipcRenderer.invoke('mcp:status'),

  // Session management
  startSession: (data) => ipcRenderer.invoke('session:start', data),
  logTrade: (trade) => ipcRenderer.invoke('session:trade', trade),
  readSession: (date) => ipcRenderer.invoke('session:read', date),
  listSessions: () => ipcRenderer.invoke('session:list'),

  // Screenshots
  getScreenshot: (filePath) => ipcRenderer.invoke('screenshot:get', filePath),

  // MCP status events
  onMcpStatus: (cb) => {
    ipcRenderer.on('mcp:status-update', (_, status) => cb(status));
  },
  onMcpConnected: (cb) => {
    ipcRenderer.on('mcp:connected', () => cb());
  },
  onMcpDisconnected: (cb) => {
    ipcRenderer.on('mcp:disconnected', () => cb());
  },

  // Remove all listeners (call on page unload)
  removeAllListeners: () => {
    ['chat:token', 'chat:tool-start', 'chat:tool-done', 'chat:done', 'chat:error',
     'mcp:status-update', 'mcp:connected', 'mcp:disconnected'].forEach(ch => {
      ipcRenderer.removeAllListeners(ch);
    });
  }
});
