'use strict'

const { app, BrowserWindow, ipcMain, dialog, shell, session, nativeTheme } = require('electron')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const settingsStore = require('./settings')
const { QBittorrentClient } = require('./qbittorrent')
const { ManagedQbittorrent } = require('./qbittorrent-managed')
const { dataDir } = require('./data-dir')

const SITE_PARTITION = 'persist:regruha'
const isDev = process.argv.includes('--dev')

let mainWindow = null

let qbittorrent = null

let managed = null

const pendingPrompts = new Map()
const pendingExternal = []

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#050505',
    autoHideMenuBar: true,
    title: 'Regruha',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' })
  })

  mainWindow.on('closed', () => { mainWindow = null })

  if (process.env.REGRUHA_DIAG) {

    mainWindow.webContents.on('did-attach-webview', (_e, wc) => {
      const ts = () => 't=' + process.uptime().toFixed(1)
      wc.on('did-fail-load', (_ev, code, desc, url, main) =>
        console.log('[site] fail', ts(), code, desc, url, 'main=' + main))
      wc.on('render-process-gone', (_ev, detail) =>
        console.log('[site] crashed', ts(), JSON.stringify(detail)))
      wc.on('did-navigate', (_ev, url, code) =>
        console.log('[site] navigate', ts(), code, url))
      wc.on('did-finish-load', () => console.log('[site] loaded', ts(), wc.getURL()))
    })
  }

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
}

function send (channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function setupSiteSession () {
  const sess = session.fromPartition(SITE_PARTITION)

  try {

    const name = app.getName().toLowerCase()
    const ua = sess.getUserAgent()
      .split(/\s+/)
      .filter(part => {
        const token = part.toLowerCase()
        if (/^electron\/[\d.]+$/.test(token)) return false
        if (/^regruha(-desktop)?\/[\d.]+$/.test(token)) return false
        if (name && token.startsWith(`${name}/`)) return false
        return true
      })
      .join(' ')
    sess.setUserAgent(ua)
  } catch {   }

  sess.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = new Set([
      'notifications',
      'clipboard-read',
      'clipboard-sanitized-write',
      'fullscreen',
      'pointerLock',
      'media',
      'idle-detection'
    ])
    callback(allowed.has(permission))
  })

  attachDownloadHandler(sess)
  return sess
}

function attachDownloadHandler (sess) {
  sess.on('will-download', (event, item) => {
    const filename = item.getFilename() || 'download'
    const url = item.getURL()
    const isTorrent = /\.torrent($|\?)/i.test(filename) || /\.torrent($|\?)/i.test(url) || item.getMimeType() === 'application/x-bittorrent'

    if (!isTorrent) {

      const target = path.join(downloadDir(), filename)
      item.setSavePath(uniquePath(target))
      item.once('done', (_e, state) => {
        if (state === 'completed') {
          send('file:downloaded', { filename, path: item.getSavePath() })
        }
      })
      return
    }

    const tempPath = path.join(os.tmpdir(), `regruha-${Date.now()}-${filename.replace(/[^\w.\-]+/g, '_')}`)
    item.setSavePath(tempPath)
    item.once('done', async (_e, state) => {
      if (state !== 'completed') {
        await removeQuietly(tempPath)
        return
      }
      await handleTorrentFile({ tempPath, filename, url })
    })
  })
}

async function removeQuietly (file) {
  try { await fsp.unlink(file) } catch {   }
}

async function handleTorrentFile ({ tempPath, filename, url }) {
  const settings = settingsStore.get()
  const size = await fsp.stat(tempPath).then(s => s.size).catch(() => 0)

  if (!settings.askForTorrentFiles) {
    await addTorrentToActiveEngine({ torrentPath: tempPath, name: filename })
    await removeQuietly(tempPath)
    return
  }

  const id = randomUUID()
  pendingPrompts.set(id, { tempPath, filename, url, size })

  setTimeout(async () => {
    if (pendingPrompts.has(id)) {
      pendingPrompts.delete(id)
      await removeQuietly(tempPath)
    }
  }, 10 * 60 * 1000).unref?.()

  send('torrent:prompt', { id, filename, url, size })
}

function downloadDir () {
  return settingsStore.getDownloadPath()
}

function uniquePath (target) {
  if (!fs.existsSync(target)) return target
  const dir = path.dirname(target)
  const ext = path.extname(target)
  const base = path.basename(target, ext)
  let index = 1
  let candidate = target
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${index})${ext}`)
    index += 1
  }
  return candidate
}

function activeEngine () {
  return 'qbittorrent'
}

function usingManaged () {
  return settingsStore.get().engine === 'qbittorrent-managed'
}

function qbClient (override) {
  const config = override || (usingManaged() && managed && managed.url
    ? { url: managed.url, username: managed.username, password: managed.password }
    : settingsStore.get().qbittorrent)
  if (!qbittorrent) qbittorrent = new QBittorrentClient(config)
  else qbittorrent.applyConfig(config)
  return qbittorrent
}

function managedEngine () {
  if (!managed) {
    managed = new ManagedQbittorrent({
      dataDir: dataDir(),
      downloadPath: settingsStore.getDownloadPath()
    })
    managed.on('status', status => send('qb:managed-status', status))
    managed.on('progress', progress => send('qb:managed-progress', progress))
  }
  return managed
}

async function ensureManagedEngine ({ allowDownload = true } = {}) {
  const instance = managedEngine()
  if (!usingManaged()) return instance.status()
  if (instance.running) return instance.status()
  try {
    await instance.start({ allowDownload })
  } catch (err) {

    if (err.code !== 'QB_NOT_DOWNLOADED') {
      console.error('[regruha] встроенный qBittorrent:', err.message)
    }
  }
  return instance.status()
}

async function stopManagedEngine () {
  if (!managed) return
  try {
    await managed.stop()
  } catch {   }
}

async function engineStatus () {
  if (activeEngine() === 'qbittorrent') {
    if (usingManaged()) {
      const instance = managedEngine()
      const managedStatus = instance.status()
      if (!instance.running) {
        return {
          engine: 'qbittorrent',
          engineId: 'qbittorrent-managed',
          managed: managedStatus,
          ready: false,
          configured: true,
          error: managedStatus.error || null,
          torrents: [],
          count: 0,
          downloadSpeed: 0,
          uploadSpeed: 0,
          active: 0
        }
      }
      try {
        return { ...(await qbClient().status()), engineId: 'qbittorrent-managed', managed: managedStatus, configured: true }
      } catch (err) {
        return { engine: 'qbittorrent', engineId: 'qbittorrent-managed', managed: managedStatus, ready: false, configured: true, error: err.message, torrents: [], count: 0, downloadSpeed: 0, uploadSpeed: 0, active: 0 }
      }
    }
    if (!qbClient().configured) {
      return { engine: 'qbittorrent', engineId: 'qbittorrent', ready: false, configured: false, error: 'Не настроено подключение к qBittorrent', torrents: [], count: 0, downloadSpeed: 0, uploadSpeed: 0, active: 0 }
    }
    try {
      return { ...(await qbClient().status()), engineId: 'qbittorrent', configured: true }
    } catch (err) {
      return { engine: 'qbittorrent', engineId: 'qbittorrent', ready: false, configured: true, error: err.message, torrents: [], count: 0, downloadSpeed: 0, uploadSpeed: 0, active: 0 }
    }
  }
}

async function addTorrentToActiveEngine (source) {
  const savePath = source.savePath || downloadDir()

  const payload = {
    magnet: source.magnet || null,
    torrentBuffer: source.torrentBuffer || null,
    torrentPath: source.torrentPath || null,
    name: source.name || null,
    savePath,
    files: Array.isArray(source.files) && source.files.length ? source.files : null
  }

  if (usingManaged()) await ensureManagedEngine()
  await qbClient().addTorrent(payload)
  send('torrent:added', { engine: 'qbittorrent' })
  return { engine: 'qbittorrent' }
}

function extractExternalTargets (argv) {
  const targets = []
  for (const arg of argv || []) {
    if (typeof arg !== 'string') continue
    if (/^magnet:/i.test(arg)) targets.push({ type: 'magnet', value: arg })
    else if (/\.torrent$/i.test(arg) && fs.existsSync(arg)) targets.push({ type: 'file', value: arg })
  }
  return targets
}

async function handleExternalTargets (targets) {
  for (const target of targets) {
    if (target.type === 'magnet') {
      send('torrent:add-request', { magnet: target.value })
    } else {
      try {
        const buffer = await fsp.readFile(target.value)
        send('torrent:add-request', {
          torrentPath: target.value,
          torrentBuffer: buffer.toString('base64'),
          name: path.basename(target.value)
        })
      } catch (err) {
        console.error('[regruha] не удалось прочитать .torrent:', err.message)
      }
    }
  }
}

function registerIpc () {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    settings: settingsStore.get()
  }))

  ipcMain.handle('app:open-external', (_e, url) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
  })

  ipcMain.handle('settings:get', () => settingsStore.get())

  ipcMain.handle('settings:set', (_e, patch) => {
    const previous = settingsStore.get()
    const next = settingsStore.set(patch || {})

    if (next.downloadPath !== previous.downloadPath) {
      if (managed) managed.downloadPath = settingsStore.getDownloadPath()
    }

    qbClient()

    if (next.engine !== previous.engine) {
      send('torrent:engine-changed', { engine: next.engine })

      if (previous.engine === 'qbittorrent-managed' && next.engine !== 'qbittorrent-managed') {
        stopManagedEngine().catch(() => {})
      }

      if (next.engine === 'qbittorrent-managed') {
        ensureManagedEngine({ allowDownload: false }).then(() => refreshStatus()).catch(() => {})
      }
    }
    return next
  })

  ipcMain.handle('dialog:choose-dir', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Папка для загрузок',
      defaultPath: downloadDir(),
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths.length) return null
    return settingsStore.set({ downloadPath: result.filePaths[0] }).downloadPath
  })

  ipcMain.handle('dialog:pick-torrent', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Открыть .torrent',
      filters: [{ name: 'Torrent', extensions: ['torrent'] }],
      properties: ['openFile']
    })
    if (result.canceled || !result.filePaths.length) return null
    const filePath = result.filePaths[0]
    const buffer = await fsp.readFile(filePath)
    return { torrentPath: filePath, torrentBuffer: buffer.toString('base64'), name: path.basename(filePath) }
  })

  ipcMain.handle('engine:status', () => engineStatus())

  ipcMain.handle('engine:pause-all', async () => {
    const list = await qbClient().list()
    await qbClient().pause(list.map(t => t.id))
    return engineStatus()
  })

  ipcMain.handle('engine:resume-all', async () => {
    const list = await qbClient().list()
    await qbClient().resume(list.map(t => t.id))
    return engineStatus()
  })

  ipcMain.handle('torrent:resolve', async () => null)

  ipcMain.handle('torrent:add', async (_e, source) => {
    try {
      const result = await addTorrentToActiveEngine(source || {})
      return { ok: true, result }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('torrent:pause', async (_e, id) => {
    await qbClient().pause(id)
    return true
  })

  ipcMain.handle('torrent:resume', async (_e, id) => {
    await qbClient().resume(id)
    return true
  })

  ipcMain.handle('torrent:remove', async (_e, { id, deleteFiles } = {}) => {
    await qbClient().remove(id, Boolean(deleteFiles))
    return true
  })

  ipcMain.handle('torrent:set-files', async (_e, { id, files } = {}) => {
    const all = await qbClient().files(id)
    await qbClient().applyFileSelection(id, files || [], all.map(f => f.index))
    return true
  })

  ipcMain.handle('torrent:files', async (_e, { id } = {}) => qbClient().files(id))

  ipcMain.handle('torrent:reveal', async (_e, id) => {
    const list = await qbClient().list()
    const item = list.find(t => t.id === id)
    const target = item && item.savePath ? path.join(item.savePath, item.name) : null
    if (!target) return false
    if (fs.existsSync(target)) shell.showItemInFolder(target)
    else if (fs.existsSync(path.dirname(target))) shell.openPath(path.dirname(target))
    else shell.openPath(downloadDir())
    return true
  })

  ipcMain.handle('torrent:open-file', async () => false)

  ipcMain.handle('torrent:prompt-decision', async (_e, { id, action, savePath } = {}) => {
    const pending = pendingPrompts.get(id)
    if (!pending) return { ok: false, error: 'Файл больше недоступен' }
    pendingPrompts.delete(id)
    return resolveTorrentPrompt(pending, action, savePath)
  })

  ipcMain.handle('qb:test', async (_e, config) => {
    try {
      const client = qbClient(config)
      const result = await client.test()
      return { ok: true, ...result }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('qb:managed-status', () => managedEngine().status())

  ipcMain.handle('qb:managed-start', async () => {
    try {
      const instance = managedEngine()
      await instance.start()
      refreshStatus().catch(() => {})
      return { ok: true, ...instance.status() }
    } catch (err) {
      return { ok: false, error: err.message, ...managedEngine().status() }
    }
  })

  ipcMain.handle('qb:managed-stop', async () => {
    await stopManagedEngine()
    refreshStatus().catch(() => {})
    return managedEngine().status()
  })

  ipcMain.handle('qb:managed-cancel', () => {
    managedEngine().cancelDownload()
    return managedEngine().status()
  })

  ipcMain.handle('qb:default-dir', async () => {
    try {
      const client = qbClient()
      await client.ensureAuth()
      const response = await client.request('/api/v2/app/preferences')
      const prefs = await response.json()
      return prefs.save_path || ''
    } catch {
      return ''
    }
  })

  ipcMain.handle('shell:open-path', async (_e, target) => {
    if (!target) return false
    return !(await shell.openPath(target))
  })
}

async function resolveTorrentPrompt (pending, action, savePath) {
  try {
    if (action === 'cancel') {
      await removeQuietly(pending.tempPath)
      return { ok: true, action }
    }

    let finalPath = pending.tempPath

    if (action === 'save' || action === 'open-and-save') {
      let target = savePath
      if (!target) {
        const result = await dialog.showSaveDialog(mainWindow, {
          title: 'Сохранить .torrent',
          defaultPath: path.join(downloadDir(), pending.filename),
          filters: [{ name: 'Torrent', extensions: ['torrent'] }]
        })
        if (result.canceled || !result.filePath) {
          if (action === 'save') {
            await removeQuietly(pending.tempPath)
            return { ok: true, action: 'cancel' }
          }
          target = null
        } else {
          target = result.filePath
        }
      }
      if (target) {
        await fsp.copyFile(pending.tempPath, target)
        finalPath = target
      }
    }

    if (action === 'open' || action === 'open-and-save') {
      await addTorrentToActiveEngine({ torrentPath: finalPath, name: pending.filename })
      if (action === 'open') await removeQuietly(pending.tempPath)
      send('torrent:added', { engine: activeEngine(), focus: true })
      return { ok: true, action }
    }

    await removeQuietly(pending.tempPath)
    return { ok: true, action: 'save', path: finalPath }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

async function refreshStatus () {
  const status = await engineStatus()
  send('engine:update', status)
  return status
}

const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
    handleExternalTargets(extractExternalTargets(argv)).catch(() => {})
  })

  app.on('open-file', (event, filePath) => {
    event.preventDefault()
    if (app.isReady()) handleExternalTargets([{ type: 'file', value: filePath }]).catch(() => {})
    else pendingExternal.push({ type: 'file', value: filePath })
  })

  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark'

    app.setAsDefaultProtocolClient('magnet')
    app.setAppUserModelId('app.regruha.desktop')

    const settings = settingsStore.get()

    setupSiteSession()

    qbittorrent = new QBittorrentClient(settings.qbittorrent)

    registerIpc()
    createWindow()

    if (settings.engine === 'qbittorrent-managed') {
      ensureManagedEngine({ allowDownload: false })
        .then(() => refreshStatus())
        .catch(err => console.error('[regruha] встроенный qBittorrent:', err.message))
    }

    const poll = setInterval(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      refreshStatus().catch(() => {})
    }, 2000)
    if (poll.unref) poll.unref()

    mainWindow.webContents.once('did-finish-load', async () => {
      send('app:ready', await engineStatus())
      const initial = [...pendingExternal, ...extractExternalTargets(process.argv)]
      pendingExternal.length = 0
      if (initial.length) await handleExternalTargets(initial)

      if (isDev) return
      if (process.env.REGRUHA_SELFTEST) {
        try {
          await require('./selftest').run(mainWindow)
          app.quit()
        } catch (err) {
          console.error('[selftest] ОШИБКА:', err.message)
          process.exitCode = 1
          app.quit()
        }
      }
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', async event => {
    const needsManaged = Boolean(managed && managed.running)
    if (!needsManaged) return
    event.preventDefault()
    try {
      await managed.stop()
    } catch {   }
    app.exit(process.exitCode || 0)
  })

  process.on('exit', () => {
    if (managed) managed.killSync()
  })

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      if (managed) managed.killSync()
      app.quit()
    })
  }
}
