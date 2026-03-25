const { contextBridge, ipcRenderer } = require('electron');

const api = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, callback) => ipcRenderer.on(channel, callback),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  readImages: () => ipcRenderer.invoke('read-images'),
  getIndexDebug: () => ipcRenderer.invoke('get-index-debug'),
};

contextBridge.exposeInMainWorld('api', api);
