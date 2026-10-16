'use strict'

const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const net = require('node:net')
const path = require('node:path')

const RELEASE = process.env.REGRUHA_QB_VERSION || 'release-5.2.4_v2.0.15'
const BASE_URL = process.env.REGRUHA_QB_BASE_URL ||
  'https://github.com/userdocs/qbittorrent-nox-static/releases/download'

const ASSETS = {
  'linux-x64': 'x86_64-qbittorrent-nox',
  'linux-arm64': 'aarch64-qbittorrent-nox',
  'linux-ia32': 'x86-qbittorrent-nox',
  'linux-arm': 'armv7-qbittorrent-nox'
}

const WINDOWS = {
  key: 'win32-x64',
  version: '5.2.4',
  url: process.env.REGRUHA_QB_WINDOWS_URL ||
    'https://github.com/qbittorrent/qBittorrent/releases/download/release-5.2.4/qbittorrent_5.2.4_lt20_x64_setup.exe',
  sha256: '28888fe5f2aa89b35d95c3a25b377755ce894fc08ac94030da9f11ccf3928cfa'
}

const READY_TIMEOUT_MS = 40000
const STOP_TIMEOUT_MS = 12000

const PBKDF2_ITERATIONS = 100000
const PBKDF2_KEYLENGTH = 64
const PBKDF2_DIGEST = 'sha512'
const WEBUI_USERNAME = 'admin'

function randomPassword () {
  return crypto.randomBytes(16).toString('base64')
}

function hashWebUiPassword (password) {
  const salt = crypto.randomBytes(16)
  const derived = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLENGTH, PBKDF2_DIGEST)
  return `${salt.toString('base64')}:${derived.toString('base64')}`
}

const IS_WINDOWS = process.platform === 'win32'
const PLATFORM = process.platform

function platformKey () {
  return `${process.platform}-${process.arch}`
}

function binaryName () {

  return IS_WINDOWS ? 'qbittorrent.exe' : 'qbittorrent-nox'
}

function configFileName () {
  return (PLATFORM === 'win32' || PLATFORM === 'darwin')
    ? 'qBittorrent.ini'
    : 'qBittorrent.conf'
}

function alternativeConfigFileName () {
  return configFileName() === 'qBittorrent.ini' ? 'qBittorrent.conf' : 'qBittorrent.ini'
}

function assetName () {
  return ASSETS[platformKey()] || null
}

function downloadUrl () {
  if (process.env.REGRUHA_QB_URL) return process.env.REGRUHA_QB_URL
  const asset = assetName()
  if (!asset) return null
  return `${BASE_URL}/${RELEASE}/${asset}`
}

function buildConfig ({ port, savePath, torrentPort, username = WEBUI_USERNAME, password = randomPassword() }) {

  const normalizedSavePath = String(savePath).replace(/\\/g, '/')
  const lines = [
    '[BitTorrent]',
    `Session\\DefaultSavePath=${normalizedSavePath}`,
    `Session\\Port=${torrentPort}`,
    'Session\\QueueingSystemEnabled=false',
    '',
    '[LegalNotice]',
    'Accepted=true',
    '',
    '[Preferences]',

    'WebUI\\Enabled=true',
    'WebUI\\Address=127.0.0.1',
    `WebUI\\Port=${port}`,
    'WebUI\\LocalHostAuth=false',
    'WebUI\\CSRFProtection=false',
    'WebUI\\ClickjackingProtection=false',
    'WebUI\\HostHeaderValidation=false',
    'WebUI\\UseUPnP=false',

    `WebUI\\Username=${username}`,
    `WebUI\\Password_PBKDF2="@ByteArray(${hashWebUiPassword(password)})"`
  ]

  if (IS_WINDOWS) {

    lines.push(
      'General\\SystrayEnabled=true',
      'Advanced\\updateCheck=false',
      '',
      '[GUI]',
      'StartUpWindowState=Hidden'
    )
  }

  lines.push('')
  return lines.join('\n')
}

function randomPort (min, max) {
  return Math.floor(min + Math.random() * (max - min))
}

async function freePort () {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function ping (url, timeoutMs = 1500) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

class ManagedQbittorrent extends EventEmitter {
  constructor ({ dataDir, downloadPath }) {
    super()
    this.dataDir = dataDir
    this.downloadPath = downloadPath
    this.home = path.join(dataDir, 'qbittorrent')
    this.profileDir = path.join(this.home, 'profile')
    this.binDir = path.join(this.home, 'bin')
    this.child = null
    this.port = null
    this.username = WEBUI_USERNAME
    this.password = randomPassword()
    this.state = 'stopped'
    this.error = null
    this._stderr = ''
  }

  get supported () {

    if (IS_WINDOWS) return Boolean(this.existingBinary())
    return Boolean(assetName()) && process.platform === 'linux'
  }

  get running () {
    return this.state === 'running' && Boolean(this.child)
  }

  get url () {
    return this.port ? `http://127.0.0.1:${this.port}` : ''
  }

  get configPath () {
    return path.join(this.profileDir, 'qBittorrent', 'config', configFileName())
  }

  alternativeConfigPath () {
    return path.join(this.profileDir, 'qBittorrent', 'config', alternativeConfigFileName())
  }

  existingBinary () {
    if (process.env.REGRUHA_QB_BINARY && fs.existsSync(process.env.REGRUHA_QB_BINARY)) {
      return process.env.REGRUHA_QB_BINARY
    }
    const name = binaryName()
    const candidates = [

      process.resourcesPath ? path.join(process.resourcesPath, 'qbittorrent', platformKey(), name) : null,

      path.join(__dirname, '..', '..', 'vendor', 'qbittorrent', platformKey(), name),

      path.join(this.binDir, name)
    ]
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) return candidate
    }
    return null
  }

  downloadTarget () {
    return path.join(this.binDir, binaryName())
  }

  _setState (state, error) {
    this.state = state
    this.error = error || null
    this.emit('status', this.status())
  }

  status () {
    return {
      state: this.state,
      supported: this.supported,
      platform: platformKey(),
      running: this.running,
      port: this.port,
      url: this.url,
      version: this.version || null,
      binary: this.existingBinary(),
      error: this.error
    }
  }

  async ensureBinary () {
    const existing = this.existingBinary()
    if (existing) return existing

    if (!this.supported) {
      const hint = IS_WINDOWS
        ? ' — положите qbittorrent.exe в vendor/qbittorrent/win32-x64/ (npm run fetch:qb win-x64) и пересоберите приложение'
        : ''
      throw new Error(`Встроенный qBittorrent недоступен для ${platformKey()}${hint}`)
    }

    const url = downloadUrl()
    if (!url) throw new Error('Не найден подходящий файл qBittorrent для этой системы')

    await fsp.mkdir(this.binDir, { recursive: true })
    const target = this.downloadTarget()
    const partial = `${target}.part`

    this._setState('downloading')

    const controller = new AbortController()
    this._downloadAbort = controller

    let response
    try {
      response = await fetch(url, { redirect: 'follow', signal: controller.signal })
    } catch (err) {
      this._setState('error', `Не удалось скачать qBittorrent: ${err.message}`)
      throw new Error(this.error)
    }

    if (!response.ok || !response.body) {
      this._setState('error', `Сервер вернул ${response.status} при скачивании qBittorrent`)
      throw new Error(this.error)
    }

    const total = Number(response.headers.get('content-length')) || 0
    const handle = await fsp.open(partial, 'w')
    let received = 0
    try {
      for await (const chunk of response.body) {
        await handle.write(chunk)
        received += chunk.length
        this.emit('progress', { received, total })
      }
    } finally {
      await handle.close()
      this._downloadAbort = null
    }

    if (total && received !== total) {
      await fsp.rm(partial, { force: true })
      this._setState('error', 'Загрузка qBittorrent оборвалась')
      throw new Error(this.error)
    }

    await fsp.rename(partial, target)
    await fsp.chmod(target, 0o755)

    return target
  }

  cancelDownload () {
    if (this._downloadAbort) {
      this._downloadAbort.abort()
      this._downloadAbort = null
    }
  }

  _writeConfig (port) {
    const savePath = this.downloadPath
    try {
      fs.mkdirSync(savePath, { recursive: true })
    } catch {   }

    const torrentPort = this.torrentPort || (this.torrentPort = randomPort(49152, 65535))
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true })
    fs.writeFileSync(this.configPath, buildConfig({
      port,
      savePath,
      torrentPort,
      username: this.username,
      password: this.password
    }), 'utf8')

    try { fs.rmSync(this.alternativeConfigPath(), { force: true }) } catch {   }
  }

  async start ({ torrentPort, allowDownload = true } = {}) {
    if (this.running) return this.url
    if (!this.supported) throw new Error(`Встроенный qBittorrent недоступен для ${platformKey()}`)

    if (torrentPort) this.torrentPort = torrentPort

    if (!allowDownload && !this.existingBinary()) {
      const err = new Error('qBittorrent ещё не скачан')
      err.code = 'QB_NOT_DOWNLOADED'
      throw err
    }

    const binary = await this.ensureBinary()

    this.port = await freePort()
    this._writeConfig(this.port)

    this._setState('starting')

    this._stderr = ''

    const env = { ...process.env }
    if (!IS_WINDOWS) env.QT_QPA_PLATFORM = 'offscreen'

    this.child = spawn(binary, [`--profile=${this.profileDir}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env
    })

    this.child.stdout.on('data', () => {})
    this.child.stderr.on('data', chunk => {
      this._stderr = (this._stderr + chunk.toString()).slice(-4000)
    })

    this.child.once('exit', (code, signal) => {
      this.child = null
      if (this.state !== 'stopped') {
        const detail = this._stderr.trim() ? `\n${this._stderr.trim()}` : ''
        this._setState('error', `qBittorrent неожиданно завершился (код ${code}, сигнал ${signal})${detail}`)
      }
    })
    this.child.once('error', err => {
      this.child = null
      this._setState('error', `Не удалось запустить qBittorrent: ${err.message}`)
    })

    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (!this.child) {
        throw new Error(this.error || 'qBittorrent завершился при запуске')
      }
      if (await ping(`${this.url}/api/v2/app/version`)) {
        this.version = await this._readVersion()
        this._setState('running')
        return this.url
      }
      await new Promise(resolve => setTimeout(resolve, 300))
    }

    await this.stop()
    throw new Error('qBittorrent не запустился за отведённое время')
  }

  async _readVersion () {
    try {
      const response = await fetch(`${this.url}/api/v2/app/version`)
      if (response.ok) return (await response.text()).trim()
    } catch {   }
    return null
  }

  async stop () {
    const child = this.child
    this._setState('stopped')
    if (!child) return
    await new Promise(resolve => {
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      child.once('exit', finish)
      try { child.kill('SIGTERM') } catch { finish() }
      setTimeout(() => {
        if (done) return
        try { child.kill('SIGKILL') } catch {   }
        finish()
      }, STOP_TIMEOUT_MS).unref()
    })

    this.child = null
    this.port = null
  }

  killSync () {
    const child = this.child
    this.child = null
    this.state = 'stopped'
    if (!child) return
    try { child.kill('SIGKILL') } catch {   }
  }
}

module.exports = { ManagedQbittorrent, platformKey, binaryName, configFileName, alternativeConfigFileName, buildConfig, hashWebUiPassword, downloadUrl, RELEASE, ASSETS, WINDOWS }
