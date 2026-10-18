'use strict';
/* ponte mínima e isolada entre a página e o processo principal: só a chamada rpc (ver SHIM em desktop/build.js) */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  rpc: (fn, args) => ipcRenderer.invoke('rpc', fn, args),
});
