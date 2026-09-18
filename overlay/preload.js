const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pick', {
  onFrame: (cb) => ipcRenderer.on('overlay:frame', (_e, url) => cb(url)),
  done: (rect) => ipcRenderer.send('overlay:done', rect),
  cancel: () => ipcRenderer.send('overlay:cancel')
});
