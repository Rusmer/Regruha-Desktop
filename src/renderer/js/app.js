'use strict'

const api = window.regruha

const state = {
  info: null,
  settings: null,
  status: { torrents: [], downloadSpeed: 0, uploadSpeed: 0, count: 0, active: 0, engine: 'qbittorrent', ready: false },
  rows: new Map(),
  view: 'site',
  siteLoaded: false,
  managed: null,
  managedProgress: null,
  devMode: false,
  brand: false
}

const dom = {}

const SITE_MIRRORS = [
  { label: 'VERCEL', url: 'https://regruha.vercel.app' },
  { label: 'CLOUDFLARE', url: 'https://regruha.pages.dev' },
  { label: 'GITHUB', url: 'https://rusmer.github.io/regruha' }
]

function mirrorLabel (url) {
  const mirror = SITE_MIRRORS.find(item => item.url === url)
  return mirror ? mirror.label : ''
}

const DEV_MODE_KEY = 'regruha.devMode'

const BRAND_KEY = 'regruha.utorrentie'

function normalizeDevUrl (value) {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  const host = trimmed.split('/')[0].split(':')[0].toLowerCase()
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
  const isLocal = host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost')
  return `${isIp || isLocal ? 'http' : 'https'}://${trimmed}`
}

document.addEventListener('DOMContentLoaded', () => {
  cacheDom()
  measureDock()
  window.addEventListener('resize', measureDock)
  window.addEventListener('load', measureDock)
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureDock).catch(() => {})
  try { state.devMode = localStorage.getItem(DEV_MODE_KEY) === '1' } catch {   }
  try { state.brand = localStorage.getItem(BRAND_KEY) === '1' } catch {   }
  bindButtons()
  bindWebview()
  bindBridge()
  if (state.brand) applyBrand()

  api.info().then(info => {
    state.info = info
    state.settings = info.settings
    applySettings()
    setView('site')
    return api.engine.status()
  }).then(status => {
    if (status) renderStatus(status)
  }).catch(err => {
    UI.toast({ type: 'error', title: 'Ошибка запуска', text: err.message })
  })
})

function cacheDom () {
  const ids = [
    'view-site', 'view-torrents', 'site-view', 'site-loader', 'site-offline', 'offline-url', 'offline-reason',
    'torrent-list', 'torrent-empty', 'engine-error', 'engine-badge',
    'card-dl', 'card-ul', 'card-count', 'card-path',
    'magnet-input', 'btn-add-magnet', 'btn-open-torrent',
    'btn-settings', 'btn-pause-all', 'btn-resume-all', 'btn-site-retry', 'btn-site-settings', 'btn-site-external',
    'site-dock', 'dock-site', 'dock-torrents', 'dock-count'
  ]
  for (const id of ids) dom[camel(id)] = document.getElementById(id)
}

function camel (value) {
  return value.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}

function measureDock () {
  if (!dom.siteDock) return
  document.documentElement.style.setProperty('--dock-h', `${dom.siteDock.offsetHeight}px`)
}

function setView (view) {
  state.view = view
  document.body.classList.toggle('is-site', view === 'site')
  dom.viewSite.classList.toggle('is-active', view === 'site')
  dom.viewTorrents.classList.toggle('is-active', view === 'torrents')
  if (dom.dockSite) dom.dockSite.classList.toggle('is-active', view === 'site')
  if (dom.dockTorrents) dom.dockTorrents.classList.toggle('is-active', view === 'torrents')
  if (view === 'torrents') refreshStatus()
}

function bindButtons () {
  dom.btnSettings.addEventListener('click', openSettings)
  dom.btnSiteSettings.addEventListener('click', openSettings)
  dom.dockSite.addEventListener('click', () => setView('site'))
  dom.dockTorrents.addEventListener('click', () => setView('torrents'))

  dom.btnAddMagnet.addEventListener('click', () => {
    const value = dom.magnetInput.value.trim()
    if (!value) {
      dom.magnetInput.focus()
      return
    }
    dom.magnetInput.value = ''
    addFromMagnet(value)
  })

  dom.magnetInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') dom.btnAddMagnet.click()
  })

  dom.btnOpenTorrent.addEventListener('click', async () => {
    const picked = await api.dialog.pickTorrent()
    if (!picked) return
    openAddDialog(picked)
  })

  dom.btnPauseAll.addEventListener('click', () => api.engine.pauseAll().then(renderStatus))
  dom.btnResumeAll.addEventListener('click', () => api.engine.resumeAll().then(renderStatus))

  dom.btnSiteRetry.addEventListener('click', () => loadSite(true))
  dom.btnSiteExternal.addEventListener('click', () => api.openExternal(state.settings.site))

  dom.torrentList.addEventListener('click', onTorrentAction)
}

const RETRY_DELAYS = [1500, 3000, 6000, 12000, 20000, 30000]
const retry = { attempts: 0, timer: null, watchdog: null, lastError: null, mainFailed: false }

function describeLoadError (code, desc) {
  if (desc) return desc
  const map = {
    '-3': 'ERR_ABORTED (соединение прервано)',
    '-7': 'ERR_TIMED_OUT (таймаут)',
    '-101': 'ERR_CONNECTION_RESET',
    '-102': 'ERR_CONNECTION_REFUSED',
    '-104': 'ERR_CONNECTION_FAILED',
    '-105': 'ERR_NAME_NOT_RESOLVED (DNS)',
    '-106': 'ERR_INTERNET_DISCONNECTED (нет сети)',
    '-118': 'ERR_CONNECTION_TIMED_OUT',
    '-130': 'ERR_PROXY_CONNECTION_FAILED'
  }
  return map[String(code)] || `код ${code}`
}

function clearSiteTimers () {
  if (retry.timer) { clearTimeout(retry.timer); retry.timer = null }
  if (retry.watchdog) { clearTimeout(retry.watchdog); retry.watchdog = null }
}

function armSiteWatchdog (ms = 45000) {
  if (retry.watchdog) clearTimeout(retry.watchdog)
  retry.watchdog = setTimeout(() => {
    retry.watchdog = null
    if (!state.siteLoaded) scheduleSiteRetry()
  }, ms)
}

function onSiteLoaded () {

  if (retry.mainFailed) return
  state.siteLoaded = true
  retry.attempts = 0
  retry.lastError = null
  clearSiteTimers()
  hideLoader()
  injectBrand()
}

function scheduleSiteRetry () {
  if (!state.settings || state.siteLoaded || retry.timer) return
  const delay = RETRY_DELAYS[Math.min(retry.attempts, RETRY_DELAYS.length - 1)]
  retry.attempts += 1

  if (retry.attempts <= 2) showLoaderOnly()
  else showOffline()
  retry.timer = setTimeout(() => {
    retry.timer = null
    if (!state.siteLoaded) {
      showLoaderOnly()
      dom.siteView.reload()
      armSiteWatchdog()
    }
  }, delay)
}

function loadSite (force) {
  const url = (state.settings && state.settings.site) || 'https://regruha.vercel.app'
  dom.offlineUrl.textContent = url
  dom.siteOffline.hidden = true
  clearSiteTimers()
  retry.attempts = 0
  retry.mainFailed = false
  showLoaderOnly()
  state.siteLoaded = false
  if (dom.siteView.getAttribute('src') !== url) dom.siteView.src = url
  else dom.siteView.reload()
  armSiteWatchdog()
}

function bindWebview () {
  const view = dom.siteView

  view.addEventListener('dom-ready', onSiteLoaded)
  view.addEventListener('did-finish-load', onSiteLoaded)

  view.addEventListener('did-navigate', () => { retry.mainFailed = false })

  view.addEventListener('did-fail-load', event => {
    if (!event.isMainFrame) return

    if (state.siteLoaded) return

    retry.mainFailed = true
    retry.lastError = describeLoadError(event.errorCode, event.errorDescription)
    scheduleSiteRetry()
  })

  view.addEventListener('did-start-loading', () => {
    if (!state.siteLoaded) showLoaderOnly()
  })

  window.addEventListener('online', () => {
    if (state.siteLoaded) return
    retry.attempts = 0
    clearSiteTimers()
    showLoaderOnly()
    dom.siteView.reload()
    armSiteWatchdog()
  })

  view.addEventListener('render-process-gone', () => {
    setTimeout(() => loadSite(true), 1000)
  })

  armSiteWatchdog()
}

function hideLoader () {
  dom.siteLoader.classList.add('is-hidden')
  dom.siteOffline.hidden = true
}

function showLoaderOnly () {
  dom.siteLoader.classList.remove('is-hidden')
}

function showOffline () {
  dom.siteLoader.classList.add('is-hidden')
  dom.siteOffline.hidden = false
  if (dom.offlineReason) {
    if (retry.lastError) {
      dom.offlineReason.hidden = false
      dom.offlineReason.textContent = `Последняя ошибка: ${retry.lastError}`
    } else {
      dom.offlineReason.hidden = true
    }
  }
}

function engineLabels (engineId) {
  if (engineId === 'qbittorrent-managed') return { short: 'QBITTORRENT АВТО', badge: 'ДВИЖОК: QBITTORRENT АВТО' }
  return { short: 'QBITTORRENT', badge: 'ДВИЖОК: QBITTORRENT' }
}

function applySettings () {
  const settings = state.settings
  const labels = engineLabels(settings.engine)
  dom.cardPath.textContent = settings.downloadPath
  dom.engineBadge.textContent = labels.badge

  if (dom.siteView.getAttribute('src') !== settings.site) {
    state.siteLoaded = false
    clearSiteTimers()
    retry.attempts = 0
    retry.mainFailed = false
    dom.siteLoader.classList.remove('is-hidden')
    dom.siteView.src = settings.site
    armSiteWatchdog()
  } else if (!state.siteLoaded) {

    if (retry.mainFailed) scheduleSiteRetry()
    else armSiteWatchdog()
  }
  const label = mirrorLabel(settings.site)
  dom.offlineUrl.textContent = label
    ? `Зеркало ${label} недоступно.`
    : (state.devMode && settings.site ? `Адрес ${settings.site} недоступен.` : 'Зеркало недоступно.')
}

function openSettings () {
  const draft = JSON.parse(JSON.stringify(state.settings))

  const body = document.createElement('div')

  const engineField = UI.el('div', 'field')
  engineField.appendChild(UI.el('div', 'field-label', 'ТОРРЕНТ-ДВИЖОК'))
  const seg = UI.el('div', 'seg')
  seg.style.flexWrap = 'wrap'
  const segManaged = UI.el('button', '', 'QBITTORRENT (АВТО)')
  const segQb = UI.el('button', '', 'СВОЙ QBITTORRENT')
  seg.append(segManaged, segQb)
  engineField.appendChild(seg)
  engineField.appendChild(UI.el('div', 'field-hint', '«АВТО» — приложение само запускает портативный qBittorrent без интерфейса (ничего устанавливать в систему не нужно). «СВОЙ» — подключение к вашему qBittorrent через WebUI.'))
  body.appendChild(engineField)

  const managedBox = UI.el('div', 'field')
  const managedHead = UI.el('div', 'field-row')
  managedHead.style.alignItems = 'center'
  const managedStatus = UI.el('span', 'field-hint')
  managedStatus.style.margin = '0'
  managedStatus.style.flex = '1'
  const managedBtn = UI.el('button', 'btn btn-ghost', 'ЗАПУСТИТЬ')
  managedBtn.type = 'button'
  managedHead.append(managedStatus, managedBtn)
  managedBox.appendChild(managedHead)
  const managedBar = UI.el('div', 'bar')
  const managedFill = UI.el('div', 'bar-fill')
  managedFill.style.width = '0%'
  managedBar.appendChild(managedFill)
  managedBar.style.display = 'none'
  managedBox.appendChild(managedBar)
  state.managedBar = { bar: managedBar, fill: managedFill }
  body.appendChild(managedBox)

  function describeManaged (status) {
    if (!status) return 'статус неизвестен'
    if (!status.supported) return `недоступно для ${status.platform || 'этой системы'}`
    if (status.state === 'running') return `запущен${status.version ? `, qBittorrent ${status.version}` : ''}, порт ${status.port}`
    if (status.state === 'downloading') return 'скачиваю qBittorrent…'
    if (status.state === 'starting') return 'запускаю…'
    if (status.state === 'error') return `ошибка: ${status.error}`
    if (status.binary) return 'готов к запуску'
    return 'потребуется скачать qBittorrent (около 64 МБ)'
  }

  function paintManaged (status) {
    state.managed = status
    const active = draft.engine === 'qbittorrent-managed'
    managedBox.style.opacity = active ? '1' : '.5'
    managedBox.style.pointerEvents = active ? 'auto' : 'none'
    managedStatus.textContent = describeManaged(status)
    managedStatus.style.color = status && status.state === 'error' ? 'var(--danger)' : ''
    const running = Boolean(status && status.running)
    managedBtn.textContent = running ? 'ОСТАНОВИТЬ' : (status && status.binary ? 'ЗАПУСТИТЬ' : 'СКАЧАТЬ И ЗАПУСТИТЬ')
    managedBtn.disabled = Boolean(status && (status.state === 'downloading' || status.state === 'starting'))
  }

  async function refreshManaged () {
    try {
      paintManaged(await api.qb.managedStatus())
    } catch (err) {
      managedStatus.textContent = `ошибка: ${err.message}`
    }
  }

  state.repaintManaged = paintManaged

  managedBtn.addEventListener('click', async () => {
    if (state.managed && state.managed.running) {
      paintManaged(await api.qb.managedStop())
      return
    }
    managedBtn.disabled = true
    managedBar.style.display = ''
    const result = await api.qb.managedStart()
    managedBar.style.display = 'none'
    managedFill.style.width = '0%'
    if (!result.ok) {
      UI.toast({ type: 'error', title: 'qBittorrent не запустился', text: result.error })
    } else {
      UI.toast({ type: 'ok', title: 'qBittorrent запущен', text: `Порт ${result.port}` })
    }
    paintManaged(result)
  })

  refreshManaged()

  const qbBox = UI.el('div', '')
  const urlField = UI.el('div', 'field')
  urlField.appendChild(UI.el('div', 'field-label', 'АДРЕС WEBUI'))
  const urlInput = UI.el('input', 'input mono')
  urlInput.value = draft.qbittorrent.url
  urlInput.placeholder = 'http://127.0.0.1:8080'
  urlField.appendChild(urlInput)
  qbBox.appendChild(urlField)

  const creds = UI.el('div', 'field-row')
  const userField = UI.el('div', 'field')
  userField.style.flex = '1'
  userField.appendChild(UI.el('div', 'field-label', 'ЛОГИН'))
  const userInput = UI.el('input', 'input')
  userInput.value = draft.qbittorrent.username
  userField.appendChild(userInput)
  const passField = UI.el('div', 'field')
  passField.style.flex = '1'
  passField.appendChild(UI.el('div', 'field-label', 'ПАРОЛЬ'))
  const passInput = UI.el('input', 'input')
  passInput.type = 'password'
  passInput.value = draft.qbittorrent.password
  passField.appendChild(passInput)
  creds.append(userField, passField)
  qbBox.appendChild(creds)

  const testRow = UI.el('div', 'field-row')
  const testBtn = UI.el('button', 'btn btn-ghost', 'ПРОВЕРИТЬ ПОДКЛЮЧЕНИЕ')
  testBtn.type = 'button'
  const testResult = UI.el('span', 'field-hint')
  testResult.style.margin = '0'
  testRow.append(testBtn, testResult)
  qbBox.appendChild(testRow)

  testBtn.addEventListener('click', async () => {
    testResult.textContent = ' проверяю…'
    const result = await api.qb.test({
      url: urlInput.value,
      username: userInput.value,
      password: passInput.value
    })
    testResult.textContent = result.ok ? ` подключено, qBittorrent ${result.version}` : ` ошибка: ${result.error}`
    testResult.style.color = result.ok ? 'var(--ok)' : 'var(--danger)'
  })

  body.appendChild(qbBox)

  const pathField = UI.el('div', 'field')
  pathField.appendChild(UI.el('div', 'field-label', 'ПАПКА ЗАГРУЗОК'))
  const pathRow = UI.el('div', 'field-row')
  const pathInput = UI.el('input', 'input mono')
  pathInput.value = draft.downloadPath
  pathInput.readOnly = true
  const pathBtn = UI.el('button', 'btn btn-ghost', 'ВЫБРАТЬ')
  pathBtn.type = 'button'
  pathBtn.addEventListener('click', async () => {
    const chosen = await api.settings.chooseDir()
    if (chosen) {
      draft.downloadPath = chosen
      pathInput.value = chosen
    }
  })
  pathRow.append(pathInput, pathBtn)
  pathField.appendChild(pathRow)
  body.appendChild(pathField)

  const siteField = UI.el('div', 'field')
  siteField.appendChild(UI.el('div', 'field-label', 'ЗЕРКАЛО САЙТА'))
  const siteSeg = UI.el('div', 'seg')
  siteSeg.style.flexWrap = 'wrap'

  const devField = UI.el('div', 'field')
  devField.appendChild(UI.el('div', 'field-label', 'СВОЙ АДРЕС (РЕЖИМ РАЗРАБОТЧИКА)'))
  const devInput = UI.el('input', 'input mono')
  devInput.type = 'text'
  devInput.spellcheck = false
  devInput.placeholder = 'https://xxxxx.pages.dev или http://192.168.0.10:3000'
  devField.appendChild(devInput)
  const devHint = UI.el('div', 'field-hint', `Доступные зеркала: ${SITE_MIRRORS.map(m => m.url).join(' · ')}`)
  devHint.dataset.noBrand = ''
  devField.appendChild(devHint)

  function isCustomSite () {
    return !SITE_MIRRORS.some(mirror => mirror.url === draft.site)
  }

  function syncSiteSeg () {
    siteButtons.forEach((button, index) => {
      button.classList.toggle('is-active', SITE_MIRRORS[index].url === draft.site)
    })
  }

  const siteButtons = SITE_MIRRORS.map(mirror => {
    const button = UI.el('button', '', mirror.label)
    button.type = 'button'
    button.addEventListener('click', () => {
      draft.site = mirror.url
      devInput.value = ''
      syncSiteSeg()
    })
    siteSeg.appendChild(button)
    return button
  })

  devInput.addEventListener('input', () => {
    const value = normalizeDevUrl(devInput.value)
    if (value) draft.site = value
    syncSiteSeg()
  })
  devInput.addEventListener('blur', () => {
    devInput.value = isCustomSite() ? draft.site : ''
  })

  siteField.appendChild(siteSeg)
  siteField.appendChild(UI.el('div', 'field-hint', 'Если одно зеркало не открывается — выберите другое.'))
  body.appendChild(siteField)

  if (isCustomSite()) devInput.value = draft.site
  if (isCustomSite()) devInput.value = draft.site
  devField.hidden = !(state.devMode || isCustomSite())
  body.appendChild(devField)
  syncSiteSeg()

  const brandField = UI.el('div', 'field')
  brandField.dataset.noBrand = ''
  brandField.appendChild(UI.el('div', 'field-label', 'UTORRENTIE!'))
  const brandBtn = UI.el('button', 'btn', '')
  brandBtn.type = 'button'
  brandBtn.id = 'btn-brand'
  function paintBrand () {
    brandBtn.textContent = state.brand ? 'ВЕРНУТЬ ОБЫЧНОЕ ИМЯ' : 'ВКЛЮЧИТЬ UTORRENTIE!'
    brandBtn.className = `btn ${state.brand ? 'btn-primary' : 'btn-ghost'}`
  }
  brandBtn.addEventListener('click', () => {
    setBrand(!state.brand)
    paintBrand()
    brandField.hidden = !(state.devMode || state.brand)
  })
  brandField.appendChild(brandBtn)
  brandField.appendChild(UI.el('div', 'field-hint', 'Пасхалка для своих: приложение и сайт начинают зваться UTORRENTIE! — как тот самый итальянский торрент-трекер.'))
  paintBrand()
  brandField.hidden = !(state.devMode || state.brand)
  body.appendChild(brandField)

  const switches = UI.el('div', '')
  function addSwitch (key, label, desc) {
    const row = UI.el('div', 'switch-row')
    const text = UI.el('div', '')
    text.appendChild(UI.el('div', 'switch-label', label))
    text.appendChild(UI.el('div', 'switch-desc', desc))
    const wrap = UI.el('label', 'switch')
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = Boolean(draft[key])
    input.addEventListener('change', () => { draft[key] = input.checked })
    wrap.append(input, UI.el('span', 'switch-track'))
    row.append(text, wrap)
    switches.appendChild(row)
  }

  addSwitch('askForTorrentFiles', 'Спрашивать перед открытием .torrent', 'Показывать окно с предложением открыть скачанный .torrent во встроенном клиенте.')
  addSwitch('revealAfterOpen', 'Открывать панель загрузок', 'Автоматически переключаться на список загрузок после добавления торрента.')
  body.appendChild(switches)

  const controller = UI.modal({
    title: 'Настройки',
    subtitle: 'Regruha Desktop',
    body,
    wide: true,
    actions: [
      { label: 'ОТМЕНА', onClick: c => c.close() },
      {
        label: 'СОХРАНИТЬ',
        className: 'btn-primary',
        ref: 'save',
        onClick: async c => {
          UI.setBusy(c, true)
          draft.qbittorrent = {
            url: urlInput.value.trim(),
            username: userInput.value,
            password: passInput.value
          }
          try {
            state.settings = await api.settings.set(draft)
            applySettings()
            UI.toast({ type: 'ok', title: 'Настройки сохранены' })
            c.close()
          } catch (err) {
            UI.toast({ type: 'error', title: 'Не удалось сохранить', text: err.message })
            UI.setBusy(c, false)
          }
        }
      }
    ]
  })

  const subtitle = controller.headMain && controller.headMain.querySelector('.modal-sub')
  if (subtitle) {
    let clicks = 0
    let timer = null
    subtitle.style.cursor = 'default'
    subtitle.addEventListener('click', () => {
      clicks += 1
      clearTimeout(timer)
      if (clicks >= 3) {
        clicks = 0
        setDevMode(!state.devMode)
      } else {
        timer = setTimeout(() => { clicks = 0 }, 1200)
      }
    })
  }

  function setDevMode (enabled) {
    state.devMode = Boolean(enabled)
    try {
      if (state.devMode) localStorage.setItem(DEV_MODE_KEY, '1')
      else localStorage.removeItem(DEV_MODE_KEY)
    } catch {   }
    if (!state.devMode && isCustomSite()) {
      draft.site = SITE_MIRRORS[0].url
      devInput.value = ''
      syncSiteSeg()
    }
    devField.hidden = !(state.devMode || isCustomSite())
    brandField.hidden = !(state.devMode || state.brand)
    if (state.devMode && isCustomSite()) devInput.value = draft.site
    UI.toast(state.devMode
      ? { type: 'ok', title: 'Режим разработчика включён', text: 'Теперь можно задать свой адрес сайта.' }
      : { type: 'info', title: 'Режим разработчика выключен' })
  }

  function syncEngineSeg () {
    const managedSel = draft.engine === 'qbittorrent-managed'
    const external = draft.engine === 'qbittorrent'
    segManaged.classList.toggle('is-active', managedSel)
    segQb.classList.toggle('is-active', external)

    qbBox.style.display = external ? '' : 'none'
    managedBox.style.display = managedSel ? '' : 'none'
    paintManaged(state.managed)
  }
  segManaged.addEventListener('click', () => { draft.engine = 'qbittorrent-managed'; syncEngineSeg() })
  segQb.addEventListener('click', () => { draft.engine = 'qbittorrent'; syncEngineSeg() })
  syncEngineSeg()

  return controller
}

const BRAND_NAME = 'UTORRENTIE!'
const BRAND_REGRUHA = /regruha/gi
const BRAND_QBITTORRENT = /qbittorrent/gi
const BRAND_QB_UP = 'UTORRENTIE'
const BRAND_QB_LOW = 'uTorrentie'
const BRAND_TO = /regruha|qbittorrent/i
const BRAND_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION'])

const brandOriginals = new Map()
let brandObserver = null

function replaceQbittorrent (matched) {
  return matched === matched.toUpperCase() ? BRAND_QB_UP : BRAND_QB_LOW
}

function brandText (text) {
  return text
    .replace(BRAND_REGRUHA, BRAND_NAME)
    .replace(BRAND_QBITTORRENT, replaceQbittorrent)
}

function brandNode (node) {
  const text = node.nodeValue
  if (!text || !BRAND_TO.test(text)) return
  if (!brandOriginals.has(node)) brandOriginals.set(node, text)
  node.nodeValue = brandText(text)
}

function brandTree (root) {
  if (!root) return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
  const batch = []
  let node
  while ((node = walker.nextNode())) {
    const parent = node.parentNode
    if (!parent || BRAND_SKIP_TAGS.has(parent.nodeName)) continue
    if (parent.closest && parent.closest('[data-no-brand]')) continue
    if (BRAND_TO.test(node.nodeValue || '')) batch.push(node)
  }
  for (const item of batch) brandNode(item)
}

function applyBrand () {
  document.title = BRAND_NAME
  brandTree(document.body)
  if (brandObserver) return
  brandObserver = new MutationObserver(mutations => {
    if (!state.brand) return
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        brandTree(mutation.target.parentNode)
      } else {
        for (const added of mutation.addedNodes) {
          if (added.nodeType === Node.ELEMENT_NODE) brandTree(added)
          else if (added.nodeType === Node.TEXT_NODE) brandNode(added)
        }
      }
    }
  })
  brandObserver.observe(document.body, { childList: true, subtree: true, characterData: true })
}

function revertBrand () {
  if (brandObserver) { brandObserver.disconnect(); brandObserver = null }
  for (const [node, original] of brandOriginals) {
    try { node.nodeValue = original } catch {   }
  }
  brandOriginals.clear()
  document.title = 'Regruha'
  injectBrandOff()
}

const BRAND_SITE_SCRIPT = `(function () {
  if (window.__utorrentie) { window.__utorrentieOn && window.__utorrentieOn(); return }
  window.__utorrentie = true
  var NAME = 'UTORRENTIE!', QB_UP = 'UTORRENTIE', QB_LOW = 'uTorrentie'
  var NICKS = ['Pajvajl', 'Пажважл']
  var TEST = /regruha|qbittorrent/i
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, INPUT: 1, TITLE: 1 }
  var changed = new Map()
  function ok (n) {
    var p = n.parentNode
    if (!p || SKIP[p.nodeName]) return false
    if (p.closest && p.closest('[data-no-brand]')) return false
    return true
  }
  function transform (text) {
    return text
      .replace(/regruha/gi, NAME)
      .replace(/qbittorrent/gi, function (m) { return m === m.toUpperCase() ? QB_UP : QB_LOW })
  }
  function pickNick () { return NICKS[Math.floor(Math.random() * NICKS.length)] }
   
  function firstText (el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i]
      if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) return n
    }
    return null
  }
   
  function nick (el, dot) {
    if (!el || !el.childNodes) return
    var t = firstText(el)
    if (!t || changed.has(t)) return
    var v = t.nodeValue
    if (dot) {
      var m = v.match(/^(·\\s*)\\S+$/)
      if (!m) return
      changed.set(t, v)
      t.nodeValue = m[1] + pickNick()
      return
    }
    changed.set(t, v)
    t.nodeValue = pickNick()
  }
  function brand (node) {
    if (!node || !node.nodeValue || !TEST.test(node.nodeValue) || !ok(node)) return
    if (!changed.has(node)) changed.set(node, node.nodeValue)
    node.nodeValue = transform(node.nodeValue)
  }
   
  function all (root, sel) {
    var list = []
    if (root.nodeType === 1 && root.matches && root.matches(sel)) list.push(root)
    if (root.querySelectorAll) list = list.concat(Array.prototype.slice.call(root.querySelectorAll(sel)))
    return list
  }
   
  function brandNicks (root) {
    if (!root) return
    var links = all(root, 'a[href^="/user/"]')
    var nameSel = '.text-white:not([class*="bg-gold"]), .text-gold'
    for (var i = 0; i < links.length; i++) {
      var lnk = links[i]
      var nameEl = (lnk.matches && lnk.matches(nameSel)) ? lnk : lnk.querySelector(nameSel)
      nick(nameEl, false)
    }
    var dots = all(root, '.font-mono.text-gold')
    for (var j = 0; j < dots.length; j++) {
      if ((dots[j].textContent || '').trim().charAt(0) === '·') nick(dots[j], true)
    }
    var golds = all(root, '.text-gold')
    for (var g = 0; g < golds.length; g++) {
      var p = golds[g].parentNode
      if (p && /^\\s*Автор:/.test(p.textContent || '')) nick(golds[g], false)
    }
    if (location.pathname.indexOf('/user/') === 0) {
      nick(document.querySelector('h1.font-display'), false)
    }
  }
  function sweep (root) {
    if (!root) return
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
    var list = [], n
    while ((n = walker.nextNode())) { if (n.nodeValue && TEST.test(n.nodeValue)) list.push(n) }
    for (var i = 0; i < list.length; i++) brand(list[i])
    brandNicks(root)
  }
  function on () {
    if (window.__utorrentieObs) return
    sweep(document.body)
    if (document.title) document.title = transform(document.title)
    window.__utorrentieObs = new MutationObserver(function (ms) {
      for (var i = 0; i < ms.length; i++) {
        var m = ms[i]
        if (m.type === 'characterData') { brand(m.target); brandNicks(m.target.parentNode) } else {
          for (var j = 0; j < m.addedNodes.length; j++) {
            var a = m.addedNodes[j]
            if (a.nodeType === 1) sweep(a)
            else if (a.nodeType === 3) brand(a)
          }
        }
      }
    })
    window.__utorrentieObs.observe(document.body, { childList: true, subtree: true, characterData: true })
  }
  function off () {
    if (window.__utorrentieObs) { window.__utorrentieObs.disconnect(); window.__utorrentieObs = null }
    changed.forEach(function (value, node) { try { node.nodeValue = value } catch (e) {} })
    changed.clear()
  }
  window.__utorrentieOn = on
  window.__utorrentieOff = off
  on()
})();`

function injectBrand () {
  if (!state.brand || !dom.siteView || typeof dom.siteView.executeJavaScript !== 'function') return
  try { dom.siteView.executeJavaScript(BRAND_SITE_SCRIPT).catch(() => {}) } catch {   }
}

function injectBrandOff () {
  if (!dom.siteView || typeof dom.siteView.executeJavaScript !== 'function') return
  try { dom.siteView.executeJavaScript('window.__utorrentieOff && window.__utorrentieOff()').catch(() => {}) } catch {   }
}

function setBrand (enabled) {
  state.brand = Boolean(enabled)
  try {
    if (state.brand) localStorage.setItem(BRAND_KEY, '1')
    else localStorage.removeItem(BRAND_KEY)
  } catch {   }
  if (state.brand) {
    applyBrand()
    injectBrand()
  } else {
    revertBrand()
  }
}

async function addFromMagnet (magnet) {
  if (!/^magnet:\?/i.test(magnet)) {
    UI.toast({ type: 'error', title: 'Это не magnet-ссылка', text: 'Вставьте ссылку вида magnet:?xt=urn:btih:…' })
    return
  }
  openAddDialog({ magnet })
}

async function openAddDialog (source) {
  const busy = UI.modal({
    title: 'Подготовка торрента',
    subtitle: 'Читаю метаданные…',
    body: UI.el('div', 'muted', '')
  })

  let meta = null
  if (source.torrentBuffer || source.torrentPath) {
    const resolved = await api.torrents.resolve({
      torrentPath: source.torrentPath || null,
      torrentBuffer: source.torrentBuffer || null
    })
    if (resolved && !resolved.error) meta = resolved
  }
  busy.close()

  const draft = {
    magnet: source.magnet || null,
    torrentPath: source.torrentPath || null,
    torrentBuffer: source.torrentBuffer || null,
    savePath: state.settings.downloadPath,
    files: meta && meta.files.length ? meta.files.map(f => f.index) : null
  }

  const body = document.createElement('div')

  const summary = UI.el('div', 'field')
  summary.appendChild(UI.el('div', 'field-label', meta ? 'РАЗДАЧА' : 'MAGNET-ССЫЛКА'))
  const name = (meta && meta.name) || source.name || (source.magnet ? 'Получение метаданных из сети…' : 'Без названия')
  const nameEl = UI.el('div', '', name)
  nameEl.dataset.noBrand = ''
  nameEl.style.fontSize = '13px'
  nameEl.style.wordBreak = 'break-all'
  nameEl.style.userSelect = 'text'
  summary.appendChild(nameEl)
  const metaLine = UI.el('div', 'field-hint')
  if (meta) {
    metaLine.textContent = `${Format.bytes(meta.length)} • файлов: ${meta.files.length} • ${meta.infoHash.slice(0, 16)}…`
  } else {
    metaLine.textContent = 'Список файлов станет доступен после получения метаданных. Выбрать файлы можно будет позже кнопкой «ФАЙЛЫ».'
  }
  summary.appendChild(metaLine)
  body.appendChild(summary)

  let fileListEl = null
  if (meta && meta.files.length) {
    const filesField = UI.el('div', 'field')
    const head = UI.el('div', 'field-label')
    head.textContent = 'ФАЙЛЫ ДЛЯ ЗАГРУЗКИ'
    filesField.appendChild(head)

    fileListEl = UI.el('div', 'file-list')
    fileListEl.dataset.noBrand = ''
    for (const file of meta.files) {
      const row = UI.el('label', 'file-row')
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = true
      checkbox.addEventListener('change', () => {
        const set = new Set(draft.files || [])
        if (checkbox.checked) set.add(file.index)
        else set.delete(file.index)
        draft.files = [...set].sort((a, b) => a - b)
      })
      row.append(checkbox, UI.el('span', 'file-row-name', file.path || file.name), UI.el('span', 'file-row-size', Format.bytes(file.length)))
      fileListEl.appendChild(row)
    }
    filesField.appendChild(fileListEl)

    const bulk = UI.el('div', 'field-row')
    bulk.style.marginTop = '8px'
    const allBtn = UI.el('button', 'btn btn-ghost btn-sm', 'ВЫБРАТЬ ВСЕ')
    const noneBtn = UI.el('button', 'btn btn-ghost btn-sm', 'СНЯТЬ ВСЕ')
    allBtn.type = 'button'
    noneBtn.type = 'button'
    allBtn.addEventListener('click', () => {
      for (const checkbox of fileListEl.querySelectorAll('input')) checkbox.checked = true
      draft.files = meta.files.map(f => f.index)
    })
    noneBtn.addEventListener('click', () => {
      for (const checkbox of fileListEl.querySelectorAll('input')) checkbox.checked = false
      draft.files = []
    })
    bulk.append(allBtn, noneBtn)
    filesField.appendChild(bulk)
    body.appendChild(filesField)
  }

  const pathField = UI.el('div', 'field')
  pathField.appendChild(UI.el('div', 'field-label', 'ПАПКА СОХРАНЕНИЯ'))
  const pathRow = UI.el('div', 'field-row')
  const pathInput = UI.el('input', 'input mono')
  pathInput.value = draft.savePath
  const pathBtn = UI.el('button', 'btn btn-ghost', 'СМЕНИТЬ')
  pathBtn.type = 'button'
  pathBtn.addEventListener('click', async () => {
    const chosen = await api.settings.chooseDir()
    if (chosen) {
      draft.savePath = chosen
      pathInput.value = chosen
    }
  })
  pathRow.append(pathInput, pathBtn)
  pathField.appendChild(pathRow)
  body.appendChild(pathField)

  UI.modal({
    title: 'Добавить торрент',
    subtitle: state.settings.engine === 'qbittorrent-managed' ? 'Встроенный qBittorrent (авто)' : 'Через подключённый qBittorrent',
    body,
    wide: true,
    actions: [
      { label: 'ОТМЕНА', onClick: c => c.close() },
      {
        label: 'СКАЧАТЬ',
        className: 'btn-primary',
        onClick: async c => {
          UI.setBusy(c, true)
          const ready = await ensureEngineReady()
          if (!ready) {
            UI.setBusy(c, false)
            UI.toast({ type: 'error', title: 'Торрент-клиент не готов', text: 'Не удалось подготовить qBittorrent.' })
            return
          }
          const result = await api.torrents.add({
            magnet: draft.magnet,
            torrentPath: draft.torrentPath,
            torrentBuffer: draft.torrentBuffer,
            savePath: draft.savePath,
            files: draft.files
          })
          if (!result.ok) {
            UI.toast({ type: 'error', title: 'Не удалось добавить', text: result.error })
            UI.setBusy(c, false)
            return
          }
          c.close()
          setView('torrents')
          UI.toast({ type: 'ok', title: 'Торрент добавлен', text: name })
          refreshStatus()
        }
      }
    ]
  })
}

let refreshTimer = null
function refreshStatus () {
  if (refreshTimer) return refreshTimer
  refreshTimer = api.engine.status().then(status => {
    refreshTimer = null
    if (status) renderStatus(status)
    return status
  }).catch(() => { refreshTimer = null })
  return refreshTimer
}

function renderStatus (status) {
  if (!status) return

  if (status.engine && status.engine !== 'qbittorrent') return

  state.status = status
  const list = state.status.torrents || []

  dom.cardDl.textContent = Format.speed(state.status.downloadSpeed)
  dom.cardUl.textContent = Format.speed(state.status.uploadSpeed)
  dom.cardCount.textContent = String(list.length)
  dom.dockCount.textContent = String(list.length)
  const labels = engineLabels(state.status.engineId || state.status.engine)
  dom.engineBadge.textContent = labels.badge

  if (state.status.error) {
    dom.engineError.hidden = false
    dom.engineError.textContent = `qBittorrent: ${state.status.error}`
  } else {
    dom.engineError.hidden = true
  }

  dom.torrentEmpty.classList.toggle('is-visible', list.length === 0)

  const seen = new Set()
  for (const torrent of list) {
    seen.add(torrent.id)
    let row = state.rows.get(torrent.id)
    if (!row) {
      row = createRow(torrent)
      state.rows.set(torrent.id, row)
      dom.torrentList.appendChild(row.el)
    }
    updateRow(row, torrent)
  }

  for (const [id, row] of state.rows) {
    if (!seen.has(id)) {
      row.el.remove()
      state.rows.delete(id)
    }
  }

  const order = list.map(t => t.id)
  Array.from(dom.torrentList.children)
    .sort((a, b) => order.indexOf(a.dataset.id) - order.indexOf(b.dataset.id))
    .forEach(node => dom.torrentList.appendChild(node))
}

function createRow (torrent) {
  const el = document.createElement('article')
  el.className = 'torrent'
  el.dataset.id = torrent.id

  el.innerHTML = `
    <div class="torrent-main">
      <div class="torrent-name" data-role="name"></div>
      <div class="torrent-meta">
        <span class="chip" data-role="state"></span>
        <span data-role="peers"></span>
        <span data-role="size"></span>
        <span data-role="eta"></span>
      </div>
    </div>
    <div class="torrent-progress">
      <div class="bar"><div class="bar-fill" data-role="bar"></div></div>
      <div class="bar-label">
        <span data-role="percent"></span>
        <span data-role="speeds"></span>
      </div>
    </div>
    <div class="torrent-actions">
      <button class="btn btn-ghost" data-act="toggle"></button>
      <button class="btn btn-ghost" data-act="files">ФАЙЛЫ</button>
      <button class="btn btn-ghost" data-act="reveal">ПАПКА</button>
      <button class="btn btn-danger" data-act="remove">УДАЛИТЬ</button>
    </div>
  `

  const refs = {}
  el.querySelectorAll('[data-role]').forEach(node => { refs[node.dataset.role] = node })
  refs.toggle = el.querySelector('[data-act="toggle"]')

  return { el, refs }
}

function updateRow (row, torrent) {
  const { el, refs } = row

  refs.name.textContent = torrent.name
  refs.name.title = torrent.name

  const statusInfo = describeState(torrent)
  refs.state.textContent = statusInfo.label
  refs.state.className = `chip ${statusInfo.cls}`

  refs.peers.textContent = `${torrent.numPeers} ${Format.plural(torrent.numPeers, 'пир', 'пира', 'пиров')}`
  refs.size.textContent = torrent.length ? Format.bytes(torrent.length) : '—'
  refs.eta.textContent = torrent.done ? 'завершено' : Format.eta(torrent.timeRemaining)

  refs.bar.style.width = Format.percent(torrent.progress)
  refs.percent.textContent = Format.percent(torrent.progress)
  refs.speeds.textContent = `↓ ${Format.speed(torrent.downloadSpeed)} · ↑ ${Format.speed(torrent.uploadSpeed)}`

  el.classList.toggle('is-done', torrent.done)
  el.classList.toggle('is-error', Boolean(torrent.error))

  refs.toggle.textContent = torrent.paused ? 'ПРОДОЛЖИТЬ' : 'ПАУЗА'
}

function describeState (torrent) {
  if (torrent.error) return { label: 'ОШИБКА', cls: 'is-error' }
  if (torrent.external && torrent.stateLabel) {
    const cls = torrent.done ? 'is-done' : (torrent.paused ? 'is-paused' : 'is-active')
    return { label: torrent.stateLabel.toUpperCase(), cls }
  }
  if (!torrent.ready) return { label: 'МЕТАДАННЫЕ', cls: 'is-active' }
  if (torrent.done) return { label: 'ЗАВЕРШЕНО', cls: 'is-done' }
  if (torrent.paused) return { label: 'ПАУЗА', cls: 'is-paused' }
  if (!torrent.numPeers) return { label: 'ПОИСК ПИРОВ', cls: 'is-paused' }
  return { label: 'СКАЧИВАЕТСЯ', cls: 'is-active' }
}

function onTorrentAction (event) {
  const button = event.target.closest('[data-act]')
  if (!button) return
  const row = button.closest('.torrent')
  if (!row) return
  const id = row.dataset.id
  const torrent = (state.status.torrents || []).find(t => t.id === id)
  if (!torrent) return

  switch (button.dataset.act) {
    case 'toggle':
      (torrent.paused ? api.torrents.resume(id) : api.torrents.pause(id))
        .then(refreshStatus)
      break
    case 'reveal':
      api.torrents.reveal(id)
      break
    case 'files':
      openFilesDialog(torrent)
      break
    case 'remove':
      removeTorrent(torrent)
      break
  }
}

async function removeTorrent (torrent) {
  const body = document.createElement('div')
  body.dataset.noBrand = ''
  body.appendChild(UI.el('div', 'muted', `«${torrent.name}»`))
  const label = UI.el('label', 'file-row')
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.checked = false
  label.append(checkbox, UI.el('span', 'file-row-name', 'Удалить также скачанные файлы с диска'))
  label.style.border = '0'
  label.style.padding = '12px 0'
  body.appendChild(label)

  const confirmed = await UI.confirm({
    title: 'Удалить торрент?',
    body,
    confirmLabel: 'УДАЛИТЬ',
    confirmClassName: 'btn-danger'
  })
  if (!confirmed) return

  await api.torrents.remove(torrent.id, checkbox.checked)
  UI.toast({ title: 'Торрент удалён', text: torrent.name })
  refreshStatus()
}

async function openFilesDialog (torrent) {
  const body = document.createElement('div')
  const listEl = UI.el('div', 'file-list')
  listEl.dataset.noBrand = ''
  body.appendChild(listEl)
  listEl.appendChild(UI.el('div', 'file-row', 'Загружаю список файлов…'))

  const controller = UI.modal({
    title: 'Файлы торрента',
    subtitle: torrent.name,
    subtitleNoBrand: true,
    body,
    wide: true,
    actions: [
      { label: 'ЗАКРЫТЬ', onClick: c => c.close() },
      {
        label: 'СОХРАНИТЬ ВЫБОР',
        className: 'btn-primary',
        onClick: async c => {
          const selected = []
          listEl.querySelectorAll('input[data-index]').forEach(input => {
            if (input.checked) selected.push(Number(input.dataset.index))
          })
          await api.torrents.setFiles(torrent.id, selected.length ? selected : [])
          c.close()
          UI.toast({ type: 'ok', title: 'Набор файлов обновлён' })
          refreshStatus()
        }
      }
    ]
  })

  let files = torrent.files && torrent.files.length ? torrent.files : null
  if (!files) files = await api.torrents.files(torrent.id)

  listEl.innerHTML = ''

  if (!files || !files.length) {
    listEl.appendChild(UI.el('div', 'file-row', 'Файлы ещё не получены. Подождите, пока найдутся пиры и загрузятся метаданные.'))
    return controller
  }

  for (const file of files) {
    const row = UI.el('label', 'file-row')
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.dataset.index = String(file.index)
    checkbox.checked = file.selected !== false
    row.append(
      checkbox,
      UI.el('span', 'file-row-name', file.path || file.name),
      UI.el('span', 'file-row-size', `${Format.bytes(file.length)} • ${Format.percent(file.progress || 0, 0)}`)
    )
    listEl.appendChild(row)
  }

  return controller
}

function bindBridge () {
  api.engine.onUpdate(status => renderStatus(status))

  api.engine.onError(err => {
    UI.toast({ type: 'error', title: 'Ошибка торрента', text: err.message })
  })

  api.qb.onManagedStatus(status => {
    state.managed = status

    if (state.repaintManaged) state.repaintManaged(status)
    if (status && status.state === 'running') {
      UI.toast({ type: 'ok', title: 'qBittorrent запущен', text: `Порт ${status.port}` })
    }
    if (status && status.state === 'error' && status.error) {
      UI.toast({ type: 'error', title: 'qBittorrent', text: status.error })
    }
  })

  api.qb.onManagedProgress(progress => {
    state.managedProgress = progress
    const ref = state.managedBar
    if (ref && progress && progress.total) {
      ref.bar.style.display = ''
      ref.fill.style.width = `${Math.round((progress.received / progress.total) * 100)}%`
    }
  })

  api.engine.onEngineChanged(async () => {
    try {
      state.settings = await api.settings.get()
    } catch {   }
    applySettings()
    refreshStatus()
  })

  api.torrents.onAdded(payload => {
    refreshStatus()
    if (state.settings.revealAfterOpen) setView('torrents')
    if (payload && payload.torrent && payload.torrent.name) {
      UI.toast({ type: 'ok', title: 'Торрент добавлен', text: payload.torrent.name })
    }
  })

  api.onAddRequest(payload => {
    setView('torrents')
    openAddDialog(payload)
  })

  api.downloads.onPrompt(payload => openTorrentPrompt(payload))

  api.downloads.onFileDownloaded(payload => {
    UI.toast({ title: 'Файл скачан', text: payload.filename })
  })

  api.onReady(status => { if (status) renderStatus(status) })
}

let ensureEnginePromise = null

function ensureEngineReady () {
  if (ensureEnginePromise) return ensureEnginePromise
  ensureEnginePromise = (async () => {
    if (!state.settings || state.settings.engine !== 'qbittorrent-managed') return true

    let status = null
    try { status = await api.qb.managedStatus() } catch { return true }
    if (status && status.running) return true

    if (status && status.supported === false) return true

    if (status && !status.binary) return installManagedEngine()

    try {
      const result = await api.qb.managedStart()
      return Boolean(result && result.ok)
    } catch {
      return false
    }
  })().finally(() => { ensureEnginePromise = null })
  return ensureEnginePromise
}

function installManagedEngine () {
  return new Promise(resolve => {
    const body = document.createElement('div')
    body.appendChild(UI.el('div', 'muted', 'Приложение один раз скачает портативный qBittorrent (около 64 МБ) и дальше будет запускать его автоматически. Устанавливать ничего в систему не нужно, отдельного окна не будет.'))

    const bar = UI.el('div', 'bar')
    bar.style.marginTop = '18px'
    const fill = UI.el('div', 'bar-fill')
    fill.style.width = '0%'
    bar.appendChild(fill)
    body.appendChild(bar)

    const statusLine = UI.el('div', 'field-hint')
    statusLine.style.marginTop = '10px'
    statusLine.textContent = 'Подготовка…'
    body.appendChild(statusLine)

    let cancelled = false
    const offProgress = api.qb.onManagedProgress(progress => {
      if (!progress || cancelled) return
      if (progress.total) {
        const ratio = Math.min(1, progress.received / progress.total)
        fill.style.width = Format.percent(ratio, 0)
        statusLine.textContent = `Скачиваю qBittorrent: ${Format.bytes(progress.received)} из ${Format.bytes(progress.total)} (${Format.percent(ratio, 0)})`
      } else {
        statusLine.textContent = `Скачиваю qBittorrent: ${Format.bytes(progress.received)}`
      }
    })

    const controller = UI.modal({
      title: 'Установка qBittorrent',
      subtitle: 'Первый торрент — подготовка клиента',
      body,
      dismissable: false,
      actions: [
        {
          label: 'ОТМЕНИТЬ',
          onClick: async c => {
            cancelled = true
            offProgress()
            try { await api.qb.managedCancel() } catch {   }
            c.close()
            resolve(false)
          }
        }
      ]
    })

    api.qb.managedStart().then(result => {
      if (cancelled) return
      offProgress()
      if (result && result.ok) {
        fill.style.width = '100%'
        statusLine.textContent = 'Готово'
        controller.close()
        resolve(true)
      } else {
        controller.close()
        UI.toast({ type: 'error', title: 'Не удалось установить qBittorrent', text: (result && result.error) || 'неизвестная ошибка' })
        resolve(false)
      }
    }).catch(err => {
      if (cancelled) return
      offProgress()
      controller.close()
      UI.toast({ type: 'error', title: 'Не удалось установить qBittorrent', text: err.message })
      resolve(false)
    })
  })
}

function openTorrentPrompt (payload) {
  setView('torrents')

  const body = document.createElement('div')

  const card = UI.el('div', 'prompt-file')
  card.dataset.noBrand = ''
  card.appendChild(UI.el('div', 'prompt-icon', '⤓'))
  const info = UI.el('div', '')
  info.appendChild(UI.el('div', 'prompt-file-name', payload.filename))
  const meta = []
  if (payload.size) meta.push(Format.bytes(payload.size))
  if (payload.url) meta.push(payload.url.length > 70 ? `${payload.url.slice(0, 70)}…` : payload.url)
  info.appendChild(UI.el('div', 'prompt-file-meta', meta.join(' • ')))
  card.appendChild(info)
  body.appendChild(card)

  body.appendChild(UI.el('div', 'muted', 'Открыть этот торрент в qBittorrent? Если клиент ещё не установлен, приложение подготовит его автоматически.'))

  let decided = false

  function decide (action) {
    decided = true
    return api.downloads.decide(payload.id, action)
  }

  const controller = UI.modal({
    title: 'Скачан .torrent',
    subtitle: 'Файл готов к открытию',
    body,
    dismissable: false,
    onClose: () => {
      if (!decided) api.downloads.decide(payload.id, 'cancel')
    },
    actions: [
      {
        label: 'ОТМЕНА',
        onClick: async c => {
          await decide('cancel')
          c.close()
        }
      },
      {
        label: 'ТОЛЬКО СОХРАНИТЬ',
        onClick: async c => {
          const result = await decide('save')
          c.close()
          if (result && result.ok) UI.toast({ type: 'ok', title: 'Файл сохранён', text: result.path })
        }
      },
      {
        label: 'ОТКРЫТЬ И СОХРАНИТЬ',
        onClick: async c => {

          decided = true
          c.close()
          const ready = await ensureEngineReady()
          if (!ready) {
            UI.toast({ type: 'error', title: 'Торрент-клиент не готов', text: 'Не удалось подготовить qBittorrent.' })
            await decide('cancel')
            return
          }
          await decide('open-and-save')
          setView('torrents')
          refreshStatus()
        }
      },
      {
        label: 'ОТКРЫТЬ',
        className: 'btn-primary',
        onClick: async c => {
          decided = true
          c.close()
          const ready = await ensureEngineReady()
          if (!ready) {
            UI.toast({ type: 'error', title: 'Торрент-клиент не готов', text: 'Не удалось подготовить qBittorrent.' })
            await decide('cancel')
            return
          }
          await decide('open')
          setView('torrents')
          refreshStatus()
        }
      }
    ]
  })

  return controller
}
