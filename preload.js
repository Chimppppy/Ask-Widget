const { contextBridge, ipcRenderer } = require('electron');

/* The renderer never sees the API key and never talks to the network. It
   asks for an answer and receives text; everything else stays in main. */
contextBridge.exposeInMainWorld('api', {
  // window
  hide: () => ipcRenderer.send('widget:hide'),
  setHeight: (h) => ipcRenderer.send('widget:height', h),
  onShown: (cb) => ipcRenderer.on('widget:shown', () => cb()),
  onHidden: (cb) => ipcRenderer.on('widget:hidden', () => cb()),

  // chrome
  chrome: () => ipcRenderer.invoke('chrome:mode'),
  isDark: () => ipcRenderer.invoke('theme:isDark'),
  onThemeChange: (cb) => ipcRenderer.on('theme:changed', (_e, dark) => cb(dark)),
  copyText: (text) => ipcRenderer.invoke('clip:write', text),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),

  // settings
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (data) => ipcRenderer.invoke('settings:save', data),
  clearKey: () => ipcRenderer.invoke('key:clear'),
  onOpenSettings: (cb) => ipcRenderer.on('open:settings', () => cb()),
  onShortcutFailed: (cb) => ipcRenderer.on('shortcut:failed', (_e, a) => cb(a)),

  // engine
  status: (force) => ipcRenderer.invoke('engine:status', !!force),
  testConnection: (candidate) => ipcRenderer.invoke('engine:test', candidate),
  ask: (payload) => ipcRenderer.invoke('engine:ask', payload),
  stop: () => ipcRenderer.send('engine:stop'),
  onDelta: (cb) => ipcRenderer.on('engine:delta', (_e, d) => cb(d)),
  onThinking: (cb) => ipcRenderer.on('engine:thinking', (_e, d) => cb(d)),
  onDone: (cb) => ipcRenderer.on('engine:done', (_e, d) => cb(d)),
  onError: (cb) => ipcRenderer.on('engine:error', (_e, d) => cb(d)),

  // tools
  mcpStatus: () => ipcRenderer.invoke('mcp:status'),
  mcpRestart: () => ipcRenderer.invoke('mcp:restart'),
  mcpReveal: () => ipcRenderer.invoke('mcp:reveal'),
  onMcpChanged: (cb) => ipcRenderer.on('mcp:changed', (_e, s) => cb(s)),
  onToolStart: (cb) => ipcRenderer.on('tool:start', (_e, d) => cb(d)),
  onToolAsk: (cb) => ipcRenderer.on('tool:ask', (_e, d) => cb(d)),
  onToolEnd: (cb) => ipcRenderer.on('tool:end', (_e, d) => cb(d)),
  onToolServer: (cb) => ipcRenderer.on('tool:server', (_e, d) => cb(d)),
  toolAnswer: (answer) => ipcRenderer.send('tool:answer', answer),

  // screen
  pickRegion: () => ipcRenderer.invoke('capture:region'),
  captureScreen: () => ipcRenderer.invoke('capture:screen'),
  onShotAdd: (cb) => ipcRenderer.on('shot:add', (_e, shot) => cb(shot))
});
