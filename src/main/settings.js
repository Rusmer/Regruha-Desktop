'use strict'

const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const { dataDir } = require('./data-dir')

const DEFAULT_SITE = 'https://regruha.vercel.app'
const SETTINGS_FILE = 'settings.json'

const ENGINES = ['qbittorrent-managed', 'qbittorrent']

function defaultDownloadPath () {
  let base
  try {
    base = app.getPath('downloads')
  } catch {
    base = app.getPath('home')
  }
  return path.join(base, 'Regruha')
}

function defaults () {
  return {
    site: DEFAULT_SITE,

    engine: 'qbittorrent-managed',
    downloadPath: defaultDownloadPath(),
    askForTorrentFiles: true,
    revealAfterOpen: true,
    qbittorrent: {
      url: 'http://127.0.0.1:8080',
      username: 'admin',
      password: ''
    }
  }
}

let cache = null

function settingsPath () {
  return path.join(dataDir(), SETTINGS_FILE)
}

function normalize (raw) {
  const base = defaults()
  const parsed = raw && typeof raw === 'object' ? raw : {}
  const merged = { ...base, ...parsed }
  merged.qbittorrent = { ...base.qbittorrent, ...(parsed.qbittorrent || {}) }
  if (!ENGINES.includes(merged.engine)) merged.engine = base.engine
  if (typeof merged.downloadPath !== 'string' || !merged.downloadPath) {
    merged.downloadPath = base.downloadPath
  }
  if (typeof merged.site !== 'string' || !/^https?:\/\//.test(merged.site)) {
    merged.site = base.site
  }
  return merged
}

function get () {
  if (cache) return cache
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
  } catch {
    raw = null
  }
  cache = normalize(raw)
  return cache
}

function set (patch) {
  const current = get()
  const next = normalize({ ...current, ...patch })
  cache = next
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch (err) {
    console.error('[settings] не удалось сохранить настройки:', err.message)
  }
  return next
}

function getDownloadPath () {
  const dir = get().downloadPath
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    console.error('[settings] не удалось создать папку загрузок:', err.message)
  }
  return dir
}

module.exports = { get, set, getDownloadPath, defaults, DEFAULT_SITE, ENGINES }
