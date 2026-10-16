'use strict'

const { contextBridge, ipcRenderer } = require('electron')

function on (channel, callback) {
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('regruha', {
  info: () => ipcRenderer.invoke('app:info'),
  openExternal: url => ipcRenderer.invoke('app:open-external', url),
  openPath: target => ipcRenderer.invoke('shell:open-path', target),

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: patch => ipcRenderer.invoke('settings:set', patch),
    chooseDir: () => ipcRenderer.invoke('dialog:choose-dir')
  },

  dialog: {
    pickTorrent: () => ipcRenderer.invoke('dialog:pick-torrent')
  },

  engine: {
    status: () => ipcRenderer.invoke('engine:status'),
    pauseAll: () => ipcRenderer.invoke('engine:pause-all'),
    resumeAll: () => ipcRenderer.invoke('engine:resume-all'),
    onUpdate: callback => on('engine:update', callback),
    onError: callback => on('engine:error', callback),
    onWarning: callback => on('engine:warning', callback),
    onEngineChanged: callback => on('torrent:engine-changed', callback)
  },

  torrents: {
    add: source => ipcRenderer.invoke('torrent:add', source),
    resolve: source => ipcRenderer.invoke('torrent:resolve', source),
    pause: id => ipcRenderer.invoke('torrent:pause', id),
    resume: id => ipcRenderer.invoke('torrent:resume', id),
    remove: (id, deleteFiles) => ipcRenderer.invoke('torrent:remove', { id, deleteFiles }),
    setFiles: (id, files) => ipcRenderer.invoke('torrent:set-files', { id, files }),
    files: id => ipcRenderer.invoke('torrent:files', { id }),
    reveal: id => ipcRenderer.invoke('torrent:reveal', id),
    openFile: (id, index) => ipcRenderer.invoke('torrent:open-file', { id, index }),
    onAdded: callback => on('torrent:added', callback)
  },

  qb: {
    test: config => ipcRenderer.invoke('qb:test', config),
    defaultDir: () => ipcRenderer.invoke('qb:default-dir'),
    managedStatus: () => ipcRenderer.invoke('qb:managed-status'),
    managedStart: () => ipcRenderer.invoke('qb:managed-start'),
    managedStop: () => ipcRenderer.invoke('qb:managed-stop'),
    managedCancel: () => ipcRenderer.invoke('qb:managed-cancel'),
    onManagedStatus: callback => on('qb:managed-status', callback),
    onManagedProgress: callback => on('qb:managed-progress', callback)
  },

  downloads: {
    decide: (id, action, savePath) => ipcRenderer.invoke('torrent:prompt-decision', { id, action, savePath }),
    onPrompt: callback => on('torrent:prompt', callback),
    onFileDownloaded: callback => on('file:downloaded', callback)
  },

  onAddRequest: callback => on('torrent:add-request', callback),
  onReady: callback => on('app:ready', callback)
})
