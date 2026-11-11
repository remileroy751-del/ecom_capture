'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => {
  const handler = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  // réglages
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  onSettingsChanged: (cb) => on('settings:changed', cb),

  // sources d'écran / fenêtres
  listSources: () => ipcRenderer.invoke('sources:list'),
  selectSource: (o) => ipcRenderer.invoke('source:select', o),

  // fichiers
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  openFolder: () => ipcRenderer.invoke('shell:open-folder'),
  openPath: (p) => ipcRenderer.invoke('shell:open', p),
  showInFolder: (p) => ipcRenderer.invoke('shell:show', p),
  listRecordings: () => ipcRenderer.invoke('recordings:list'),
  deleteRecording: (p) => ipcRenderer.invoke('recordings:delete', p),

  // enregistrement (écriture progressive sur le disque)
  recOpen: (o) => ipcRenderer.invoke('rec:open', o),
  recChunk: (id, data) => ipcRenderer.send('rec:chunk', id, data),
  recClose: (id) => ipcRenderer.invoke('rec:close', id),
  recState: (s) => ipcRenderer.send('rec:state', s),

  // interface pendant l'enregistrement
  uiEnter: () => ipcRenderer.invoke('ui:enter'),
  uiToolbar: () => ipcRenderer.invoke('ui:toolbar'),
  uiExit: () => ipcRenderer.invoke('ui:exit'),
  countdown: (n) => ipcRenderer.invoke('countdown:run', n),
  countdownCancel: () => ipcRenderer.send('countdown:cancel'),
  onCountdown: (cb) => on('countdown:n', cb),

  // caméra
  camSync: () => ipcRenderer.invoke('cam:sync'),
  camClose: () => ipcRenderer.send('cam:close'),

  // barre flottante
  toolbarAction: (a) => ipcRenderer.send('toolbar:action', a),
  onToolbarState: (cb) => on('toolbar:state', cb),

  // conversion MP4 / MP3
  convertStart: (o) => ipcRenderer.invoke('convert:start', o),
  onConvertProgress: (cb) => on('convert:progress', cb),
  onConvertDone: (cb) => on('convert:done', cb)
});
