'use strict'

const fs = require('node:fs')

class QBittorrentError extends Error {
  constructor (message, status) {
    super(message)
    this.name = 'QBittorrentError'
    this.status = status || 0
  }
}

function normalizeUrl (value) {
  let url = String(value || '').trim()
  if (!url) return ''
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`
  return url.replace(/\/+$/, '')
}

const STATE_LABELS = {
  error: 'Ошибка',
  missingFiles: 'Файлы не найдены',
  uploading: 'Раздаётся',
  pausedUP: 'Пауза (раздача)',
  queuedUP: 'В очереди (раздача)',
  stalledUP: 'Раздача без пиров',
  checkingUP: 'Проверка (раздача)',
  forcedUP: 'Раздача (принудительно)',
  allocating: 'Выделение места',
  downloading: 'Скачивается',
  metaDL: 'Получение метаданных',
  pausedDL: 'Пауза',
  queuedDL: 'В очереди',
  stalledDL: 'Нет пиров',
  checkingDL: 'Проверка',
  forcedDL: 'Скачивается (принудительно)',
  checkingResumeData: 'Проверка данных',
  moving: 'Перемещение',
  unknown: 'Неизвестно'
}

class QBittorrentClient {
  constructor (config = {}) {
    this.url = normalizeUrl(config.url)
    this.username = config.username || 'admin'
    this.password = config.password || ''
    this.sid = null
    this.sidName = 'SID'
    this.version = null
  }

  get configured () {
    return Boolean(this.url)
  }

  applyConfig (config = {}) {
    const url = normalizeUrl(config.url)
    const username = config.username !== undefined ? (config.username || 'admin') : this.username
    const password = config.password !== undefined ? (config.password || '') : this.password
    if (url !== this.url || username !== this.username || password !== this.password) {
      this.sid = null
    }
    this.url = url
    this.username = username
    this.password = password
  }

  async request (pathname, options = {}) {
    if (!this.url) throw new QBittorrentError('Не задан адрес qBittorrent WebUI')
    const { method = 'GET', body, headers = {}, form, retry = true } = options

    const init = { method, headers: { ...headers } }
    if (body !== undefined) {
      init.body = body
      if (!init.headers['Content-Type']) {
        init.headers['Content-Type'] = 'application/x-www-form-urlencoded'
      }
    }
    if (form) {
      init.body = form
    }
    if (this.sid) init.headers.Cookie = `${this.sidName}=${this.sid}`
    init.headers.Referer = `${this.url}/`
    init.headers.Origin = this.url

    let response
    try {
      response = await fetch(`${this.url}${pathname}`, init)
    } catch (err) {
      throw new QBittorrentError(`Не удалось подключиться к qBittorrent: ${err.message}`)
    }

    this._captureSid(response)

    if (response.status === 403 && retry) {
      this.sid = null
      await this.login()
      return this.request(pathname, { ...options, retry: false })
    }

    return response
  }

  _captureSid (response) {
    const cookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean)

    for (const raw of cookies) {
      if (!raw) continue
      const match = /(?:^|[;\s])([A-Za-z0-9_]*SID[A-Za-z0-9_]*)=([^;,\s]+)/i.exec(raw)
      if (match) {
        this.sidName = match[1]
        this.sid = match[2]
        return true
      }
    }
    return false
  }

  async login () {
    const form = new URLSearchParams()
    form.set('username', this.username)
    form.set('password', this.password)

    let response
    try {
      response = await fetch(`${this.url}/api/v2/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: `${this.url}/`,
          Origin: this.url
        },
        body: form.toString()
      })
    } catch (err) {
      throw new QBittorrentError(`Не удалось подключиться к qBittorrent: ${err.message}`)
    }

    this.sid = null
    this.sidName = 'SID'
    this._captureSid(response)

    const status = response.status
    const text = (await response.text()).trim()

    if (status === 401 || status === 403) {

      if (await this._apiAccessible()) return true
      if (status === 403) {
        throw new QBittorrentError('qBittorrent отклонил вход (бан или слишком много попыток). Перезапустите qBittorrent или задайте пароль заново.')
      }
      throw new QBittorrentError('Неверный логин или пароль qBittorrent WebUI')
    }

    if (status >= 200 && status < 300) {

      if (text && text.toLowerCase() !== 'ok.') throw new QBittorrentError(text)
      return true
    }

    if (await this._apiAccessible()) return true
    throw new QBittorrentError(`Не удалось войти в qBittorrent (${status})`, status)
  }

  async _apiAccessible () {
    try {
      const headers = { Referer: `${this.url}/`, Origin: this.url }
      if (this.sid) headers.Cookie = `${this.sidName}=${this.sid}`
      const response = await fetch(`${this.url}/api/v2/app/version`, { headers })
      return response.ok
    } catch {
      return false
    }
  }

  async ensureAuth () {
    if (!this.sid) await this.login()
  }

  async test () {
    await this.login()
    const response = await this.request('/api/v2/app/version')
    const version = (await response.text()).trim()
    this.version = version
    return { ok: true, version, url: this.url }
  }

  async list () {
    await this.ensureAuth()
    const response = await this.request('/api/v2/torrents/info')
    if (!response.ok) throw new QBittorrentError(`qBittorrent вернул ${response.status}`, response.status)
    const data = await response.json()
    return (Array.isArray(data) ? data : []).map(item => this._normalize(item))
  }

  async transferInfo () {
    await this.ensureAuth()
    const response = await this.request('/api/v2/transfer/info')
    if (!response.ok) return { downloadSpeed: 0, uploadSpeed: 0 }
    const data = await response.json()
    return {
      downloadSpeed: data.dl_info_speed || 0,
      uploadSpeed: data.up_info_speed || 0
    }
  }

  async status () {
    const torrents = await this.list()
    let transfer = { downloadSpeed: 0, uploadSpeed: 0 }
    try {
      transfer = await this.transferInfo()
    } catch {   }
    return {
      engine: 'qbittorrent',
      ready: true,
      downloadPath: '',
      count: torrents.length,
      active: torrents.filter(t => !t.paused && !t.done && t.downloadSpeed > 0).length,
      downloadSpeed: transfer.downloadSpeed,
      uploadSpeed: transfer.uploadSpeed,
      torrents
    }
  }

  async addTorrent (source = {}) {
    await this.ensureAuth()
    const form = new FormData()

    if (source.magnet) {
      form.append('urls', source.magnet)
    } else if (source.torrentBuffer) {
      const buffer = Buffer.from(source.torrentBuffer, 'base64')
      form.append('torrents', new Blob([buffer], { type: 'application/x-bittorrent' }), 'file.torrent')
    } else if (source.torrentPath) {
      const buffer = await fs.promises.readFile(source.torrentPath)
      form.append('torrents', new Blob([buffer], { type: 'application/x-bittorrent' }), 'file.torrent')
    } else {
      throw new QBittorrentError('Пустой источник торрента')
    }

    if (source.savePath) form.append('savepath', source.savePath)
    if (source.category) form.append('category', source.category)
    if (source.tags) form.append('tags', source.tags)
    form.append('paused', source.paused ? 'true' : 'false')
    form.append('autoTMM', 'false')

    const response = await this.request('/api/v2/torrents/add', { method: 'POST', form })
    if (response.status === 409) return true
    if (!response.ok) throw new QBittorrentError(`Не удалось добавить торрент (${response.status})`, response.status)

    const text = (await response.text()).trim()
    if (!text || text === 'Ok.') return true

    try {
      const data = JSON.parse(text)
      if (data && typeof data === 'object') {
        const added = Array.isArray(data.added_torrent_ids) ? data.added_torrent_ids.length : 0
        if (data.failure_count > 0 && data.success_count === 0 && added === 0 && !data.pending_count) {
          throw new QBittorrentError('qBittorrent не принял торрент')
        }
        return true
      }
    } catch (err) {
      if (err instanceof QBittorrentError) throw err
    }

    throw new QBittorrentError(text)
  }

  async pause (hashes) {

    await this._postAny(['/api/v2/torrents/stop', '/api/v2/torrents/pause'], {
      hashes: [].concat(hashes).join('|')
    })
  }

  async resume (hashes) {
    await this._postAny(['/api/v2/torrents/start', '/api/v2/torrents/resume'], {
      hashes: [].concat(hashes).join('|')
    })
  }

  async remove (hashes, deleteFiles = false) {
    await this._postAny(['/api/v2/torrents/delete'], {
      hashes: [].concat(hashes).join('|'),
      deleteFiles: deleteFiles ? 'true' : 'false'
    })
  }

  async files (hash) {
    await this.ensureAuth()
    const response = await this.request(`/api/v2/torrents/files?hash=${encodeURIComponent(hash)}`)
    if (!response.ok) return []
    const data = await response.json()
    return (Array.isArray(data) ? data : []).map((file, index) => ({
      index,
      name: file.name.split('/').pop() || file.name,
      path: file.name,
      length: file.size,
      progress: file.progress || 0,
      selected: (file.priority || 0) !== 0
    }))
  }

  async setFilePriorities (hash, priorities) {

    if (!priorities.length) return
    const form = new URLSearchParams()
    form.set('hash', hash)
    form.set('id', priorities.map(p => p.id).join('|'))
    form.set('priority', priorities.map(p => p.priority).join('|'))
    await this._postAny(['/api/v2/torrents/filePrio'], form, true)
  }

  async applyFileSelection (hash, selectedIndices, totalIndices) {
    const wanted = new Set(selectedIndices)
    const priorities = []
    for (const id of totalIndices) {
      priorities.push({ id, priority: wanted.has(id) ? 1 : 0 })
    }
    await this.setFilePriorities(hash, priorities)
  }

  async _postAny (paths, params, raw = false) {
    let lastStatus = 0
    for (const pathname of paths) {
      const response = await this._post(pathname, params, raw)
      if (response.ok) return response
      lastStatus = response.status
      if (response.status !== 404) break
    }
    throw new QBittorrentError(`qBittorrent вернул ${lastStatus}`, lastStatus)
  }

  async _post (pathname, params, raw = false) {
    await this.ensureAuth()
    const body = raw ? params : new URLSearchParams(params)
    return this.request(pathname, { method: 'POST', body: body.toString() })
  }

  _normalize (item) {
    const progress = Number(item.progress) || 0
    const state = item.state || 'unknown'
    const paused = /paused|stopped/i.test(state)
    return {
      id: item.hash,
      name: item.name,
      progress,
      downloaded: item.downloaded || 0,
      uploaded: item.uploaded || 0,
      length: item.size || item.total_size || 0,
      downloadSpeed: item.dlspeed || 0,
      uploadSpeed: item.upspeed || 0,
      numPeers: (item.num_leechs || 0) + (item.num_seeds || 0),
      timeRemaining: item.eta && item.eta < 8640000 ? item.eta : 0,
      ratio: item.ratio || 0,
      done: progress >= 1,
      paused,
      ready: true,
      error: state === 'error' || state === 'missingFiles' ? (STATE_LABELS[state] || 'Ошибка') : null,
      savePath: item.save_path || '',
      magnetURI: `magnet:?xt=urn:btih:${item.hash}`,
      files: [],
      numFiles: item.num_files || 0,
      state,
      stateLabel: STATE_LABELS[state] || state,
      category: item.category || '',
      tags: item.tags || '',
      external: true
    }
  }
}

module.exports = { QBittorrentClient, QBittorrentError, STATE_LABELS }
