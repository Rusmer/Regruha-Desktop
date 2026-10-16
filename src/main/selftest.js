'use strict'

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { app, webContents } = require('electron')

const OUT_BASE = process.env.REGRUHA_SELFTEST
const TORRENT_FILE = process.env.REGRUHA_SELFTEST_TORRENT
const SELFTEST_ENGINE = process.env.REGRUHA_SELFTEST_ENGINE || 'managed'
const USE_QBITTORRENT = SELFTEST_ENGINE === 'qbittorrent'
const USE_MANAGED = SELFTEST_ENGINE === 'managed'
const ENGINE_ID = USE_QBITTORRENT ? 'qbittorrent' : 'qbittorrent-managed'

const results = []
const consoleErrors = []

function record (name, ok, details) {
  results.push({ name, ok: Boolean(ok), details: details === undefined ? null : details })
  console.log(`[selftest] ${ok ? 'OK  ' : 'FAIL'} ${name}${details !== undefined ? ` — ${JSON.stringify(details)}` : ''}`)
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor (label, fn, { timeout = 30000, interval = 250 } = {}) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeout) {
    try {
      last = await fn()
      if (last) return last
    } catch (err) {
      last = err.message
    }
    await sleep(interval)
  }
  throw new Error(`таймаут ожидания «${label}» (последнее значение: ${JSON.stringify(last)})`)
}

function screenshot (win, suffix) {
  return win.webContents.capturePage().then(image => {
    const file = `${OUT_BASE}.${suffix}.png`
    fs.writeFileSync(file, image.toPNG())
    console.log(`[selftest] скриншот: ${file} (${image.getSize().width}x${image.getSize().height})`)
    return file
  })
}

function startTorrentServer (file) {
  const server = http.createServer((req, res) => {
    if (!req.url.startsWith('/test.torrent')) {
      res.writeHead(404).end('not found')
      return
    }
    const data = fs.readFileSync(file)
    res.writeHead(200, {
      'Content-Type': 'application/x-bittorrent',
      'Content-Disposition': 'attachment; filename="Regruha Test Movie.torrent"',
      'Content-Length': data.length
    })
    res.end(data)
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

async function run (win) {
  const settingsStore = require('./settings')

  const workDir = path.join(path.dirname(OUT_BASE), 'selftest-data')
  fs.mkdirSync(workDir, { recursive: true })

  settingsStore.set({
    downloadPath: path.join(workDir, 'downloads'),
    askForTorrentFiles: true,
    revealAfterOpen: true,
    engine: ENGINE_ID
  })

  if (USE_QBITTORRENT) {
    settingsStore.set({
      qbittorrent: {
        url: process.env.REGRUHA_SELFTEST_QB_URL || 'http://127.0.0.1:8080',
        username: process.env.REGRUHA_SELFTEST_QB_USER || 'admin',
        password: process.env.REGRUHA_SELFTEST_QB_PASSWORD || ''
      }
    })

    try {
      const { QBittorrentClient } = require('./qbittorrent')
      const client = new QBittorrentClient(settingsStore.get().qbittorrent)
      const existing = await client.list()
      if (existing.length) {
        await client.remove(existing.map(t => t.id), false)
        console.log(`[selftest] очищено торрентов qBittorrent: ${existing.length}`)
      }
    } catch (err) {
      console.log(`[selftest] не удалось очистить qBittorrent: ${err.message}`)
    }
  }

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) consoleErrors.push(message)
  })

  const evaluate = code => win.webContents.executeJavaScript(code, true)

  win.webContents.send('torrent:engine-changed', { engine: settingsStore.get().engine })

  const ui = await waitFor('загрузка интерфейса', async () => {
    const state = await evaluate(`(() => ({
      hasApi: typeof window.regruha === 'object',
      hasWebview: !!document.getElementById('site-view'),
      dockButtons: document.querySelectorAll('.dock-btn').length,
      torrentList: !!document.getElementById('torrent-list')
    }))()`)
    return state && state.hasApi && state.hasWebview && state.dockButtons >= 2 ? state : null
  })
  record('интерфейс загружен', true, ui)

  await evaluate(`(() => {
    window.__modalLog = []
    const original = window.UI.modal
    window.UI.modal = function (options) {
      window.__modalLog.push((options && options.title) || '?')
      return original.apply(this, arguments)
    }
    return true
  })()`)

  const settings = settingsStore.get()
  record('папка загрузок изолирована', settings.downloadPath.includes('selftest-data'), settings.downloadPath)

  await evaluate(`document.getElementById('dock-torrents').click()`)
  await sleep(600)
  const panel = await evaluate(`(() => ({
    active: document.getElementById('view-torrents').classList.contains('is-active'),
    engineBadge: document.getElementById('engine-badge').textContent,
    emptyVisible: document.getElementById('torrent-empty').classList.contains('is-visible')
  }))()`)
  record('панель загрузок открывается', panel.active, panel)
  await screenshot(win, 'panel')

  const engineStatus = await waitFor('инициализация движка', async () => {
    const status = await evaluate(`window.regruha.engine.status()`)
    return status && (status.ready || status.error) ? status : null
  }, { timeout: 40000 })
  record('торрент-движок запущен', Boolean(engineStatus.ready), {
    engine: engineStatus.engine,
    ready: engineStatus.ready,
    error: engineStatus.error || null
  })

  const stray = await evaluate(`(() => {
    const modal = document.querySelector('.modal')
    return modal ? modal.querySelector('.modal-title').textContent : null
  })()`)
  record('до загрузки нет открытых окон', stray === null, stray)

  const { server, port } = await startTorrentServer(TORRENT_FILE)
  const url = `http://127.0.0.1:${port}/test.torrent`

  const view = webContents.getAllWebContents().find(wc => wc.getType() === 'webview')
  if (!view) throw new Error('webview не найден')
  view.loadURL(url)

  const prompt = await waitFor('окно предложения открыть .torrent', async () => {
    const state = await evaluate(`(() => {
      const modal = document.querySelector('.modal')
      if (!modal) return null
      return {
        title: modal.querySelector('.modal-title').textContent,
        file: (modal.querySelector('.prompt-file-name') || {}).textContent || null,
        buttons: [...modal.querySelectorAll('.modal-foot button')].map(b => b.textContent),
        log: window.__modalLog || []
      }
    })()`)
    return state && state.title === 'Скачан .torrent' ? state : null
  }, { timeout: 45000 })
  record('перехвачен .torrent со страницы', prompt.file === 'Regruha Test Movie.torrent', prompt)
  await screenshot(win, 'prompt')

  const clicked = await evaluate(`(() => {
    const modal = document.querySelector('.modal')
    const button = [...modal.querySelectorAll('.modal-foot button')]
      .find(b => b.textContent.trim() === 'ОТКРЫТЬ')
    if (!button) return false
    button.click()
    return true
  })()`)
  record('нажата кнопка «ОТКРЫТЬ»', clicked)

  const added = await waitFor('торрент появился в списке', async () => {
    const state = await evaluate(`(() => ({
      rows: [...document.querySelectorAll('.torrent')].map(r => ({
        name: r.querySelector('.torrent-name').textContent,
        state: r.querySelector('[data-role="state"]').textContent
      })),
      modalOpen: !!document.querySelector('.modal'),
      engine: document.getElementById('engine-badge').textContent
    }))()`)
    return state && state.rows.length && !state.modalOpen ? state : null
  }, { timeout: 45000 })
  record('торрент добавлен во встроенный клиент', added.rows.length === 1, added)
  record('модальное окно закрылось', !added.modalOpen)
  await sleep(2500)
  await screenshot(win, 'torrent')

  const controls = await evaluate(`(() => {
    const row = document.querySelector('.torrent')
    return row ? [...row.querySelectorAll('[data-act]')].map(b => b.dataset.act) : []
  })()`)
  record('кнопки управления на месте', ['toggle', 'files', 'reveal', 'remove'].every(a => controls.includes(a)), controls)

  const summary = await evaluate(`(() => ({
    dl: document.getElementById('card-dl').textContent,
    ul: document.getElementById('card-ul').textContent,
    count: document.getElementById('card-count').textContent,
    path: document.getElementById('card-path').textContent
  }))()`)
  record('сводка заполнена', summary.count === '1', summary)

  await evaluate(`document.getElementById('btn-settings').click()`)
  await sleep(500)
  const settingsModal = await evaluate(`(() => {
    const modal = document.querySelector('.modal')
    return modal ? { title: modal.querySelector('.modal-title').textContent, body: modal.textContent.includes('QBITTORRENT') } : null
  })()`)
  record('окно настроек открывается', settingsModal && settingsModal.body, settingsModal)
  await screenshot(win, 'settings')

  const devReveal = await evaluate(`(() => {
    const sub = document.querySelector('.modal-head .modal-sub')
    if (!sub) return { ok: false, reason: 'нет подзаголовка' }
    sub.click(); sub.click(); sub.click()
    const field = Array.from(document.querySelectorAll('.modal-body .field'))
      .find(f => /СВОЙ АДРЕС/.test(f.textContent))
    if (!field) return { ok: false, reason: 'поле не найдено' }
    return { ok: !field.hidden, hidden: field.hidden, input: Boolean(field.querySelector('input')) }
  })()`)
  record('режим разработчика: поле своего адреса открывается', devReveal.ok === true && devReveal.input === true, devReveal)

  const brandClick = await evaluate(`(() => {
    const button = document.getElementById('btn-brand')
    if (!button) return { ok: false, reason: 'кнопка не найдена' }
    button.click()
    return { ok: true, label: button.textContent }
  })()`)
  await sleep(400)
  const branded = await evaluate(`(() => ({
    title: document.title,
    loader: (document.querySelector('.loader-text') || {}).textContent || null,
    subtitle: (document.querySelector('.modal-sub') || {}).textContent || null,
    badge: document.getElementById('engine-badge').textContent
  }))()`)
  const brandOk = brandClick.ok &&
    branded.title === 'UTORRENTIE!' &&
    /UTORRENTIE!/.test(branded.loader || '') &&
    /UTORRENTIE/.test(branded.badge || '') &&
    !/QBITTORRENT/i.test(branded.badge || '')
  record('пасхалка UTORRENTIE! включается', brandOk, branded)

  const ipcSaved = await evaluate(`window.regruha.settings.set({}).then(s => ({ ok: true, engine: s && s.engine })).catch(e => ({ ok: false, message: e.message }))`)
  record('настройки сохраняются через IPC', ipcSaved && ipcSaved.ok, ipcSaved)

  await evaluate(`document.querySelector('.modal-close').click()`)

  const relevantErrors = consoleErrors.filter(message =>
    !/Security Warning|allowpopups|Content-Security-Policy|ERR_ABORTED/i.test(message)
  )
  record('нет ошибок в консоли', relevantErrors.length === 0, relevantErrors.slice(0, 5))

  const modalLog = await evaluate(`window.__modalLog || []`)
  record('лишних модальных окон не открывалось', modalLog.filter(t => t !== 'Скачан .torrent' && t !== 'Настройки' && t !== 'Подготовка торрента').length === 0, modalLog)

  server.close()
  return results
}

module.exports = { run, results }
