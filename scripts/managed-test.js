'use strict'

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const crypto = require('node:crypto')

const ROOT = path.resolve(__dirname, '..')

let activeInstance = null
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try { if (activeInstance) activeInstance.killSync() } catch {   }
    process.exit(128 + (signal === 'SIGINT' ? 2 : 15))
  })
}

let passed = 0
let failed = 0

function check (label, ok, details) {
  if (ok) { passed++; console.log(`  OK   ${label}${details === undefined ? '' : ` — ${JSON.stringify(details)}`}`) }
  else { failed++; console.log(`  FAIL ${label}${details === undefined ? '' : ` — ${JSON.stringify(details)}`}`) }
}

function passwordMatches (config, password) {
  const line = config.split('\n').find(l => l.startsWith('WebUI\\Password_PBKDF2'))
  if (!line) return false
  const match = /@ByteArray\(([^)]*)\)/.exec(line)
  if (!match) return false
  const [saltB64, hashB64] = match[1].split(':')
  if (!saltB64 || !hashB64) return false
  const salt = Buffer.from(saltB64, 'base64')
  const derived = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512')
  return derived.toString('base64') === hashB64
}

async function main () {
  const { binaryName, configFileName } = require(path.join(ROOT, 'src/main/qbittorrent-managed.js'))
  const vendorBinary = path.join(ROOT, 'vendor', 'qbittorrent', `${process.platform}-${process.arch}`, binaryName())
  const fallback = fs.existsSync(vendorBinary) ? vendorBinary : null
  const binary = process.argv[2] || process.env.REGRUHA_QB_BINARY || fallback
  if (!binary || !fs.existsSync(binary)) {
    console.log('нужен путь к qbittorrent-nox (аргумент, REGRUHA_QB_BINARY или vendor/qbittorrent/…)')
    console.log('скачать: npm run fetch:qb')
    process.exit(2)
  }
  process.env.REGRUHA_QB_BINARY = binary

  const Module = require('node:module')
  const origResolve = Module._resolveFilename
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'electron') return require.resolve('./_electron-stub.js')
    return origResolve.call(this, request, ...rest)
  }

  const { ManagedQbittorrent } = require(path.join(ROOT, 'src/main/qbittorrent-managed.js'))
  const { QBittorrentClient } = require(path.join(ROOT, 'src/main/qbittorrent.js'))

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regruha-managed-'))
  const downloadPath = path.join(dataDir, 'downloads')

  const instance = new ManagedQbittorrent({ dataDir, downloadPath })
  activeInstance = instance
  let lastProgress = null
  instance.on('progress', p => { lastProgress = p })
  instance.on('status', s => console.log(`  [статус] ${s.state}${s.error ? ' — ' + s.error : ''}`))

  console.log(`\n[1] Наличие бинарника`)
  check('бинарник найден', Boolean(instance.existingBinary()), instance.existingBinary())
  check('платформа поддерживается', instance.supported, process.platform + '-' + process.arch)

  console.log(`\n[2] Запуск без интерфейса`)
  const url = await instance.start()
  check('WebUI отвечает', Boolean(url), url)
  check('состояние running', instance.running)
  check('версия получена', Boolean(instance.version), instance.version)

  console.log(`\n[3] Конфигурация портала и папки`)
  const conf = fs.readFileSync(instance.configPath, 'utf8')
  check('имя файла настроек по платформе', path.basename(instance.configPath) === configFileName(), path.basename(instance.configPath))
  check('WebUI только на 127.0.0.1', /WebUI\\Address=127\.0\.0\.1/.test(conf))
  check('локальная авторизация отключена', /WebUI\\LocalHostAuth=false/.test(conf))
  check('UPnP отключён', /WebUI\\UseUPnP=false/.test(conf))
  check('папка загрузок прописана', conf.includes(`Session\\DefaultSavePath=${downloadPath}`), downloadPath)
  check('логин WebUI задан', /WebUI\\Username=admin/.test(conf))
  check('пароль WebUI задан (PBKDF2) и верен', passwordMatches(conf, instance.password))

  console.log(`\n[4] Порт слушается только локально`)
  const listening = await new Promise(resolve => {
    const { execFile } = require('node:child_process')
    execFile('ss', ['-ltn'], (err, stdout) => resolve(stdout || ''))
  })
  const line = listening.split('\n').find(l => l.includes(`:${instance.port} `) || l.includes(`:${instance.port}\t`))
  check('порт привязан к 127.0.0.1', Boolean(line) && line.includes('127.0.0.1'), (line || '').trim())

  console.log(`\n[5] Клиент WebUI: без пароля и с логином`)
  const anon = new QBittorrentClient({ url: instance.url, username: '', password: '' })
  const anonVersion = await anon.request('/api/v2/app/version').then(r => r.text())
  check('версия через клиент без пароля', Boolean(anonVersion), anonVersion.trim())

  const client = new QBittorrentClient({ url: instance.url, username: instance.username, password: instance.password })
  const authed = await client.login()
  check('вход по логину/паролю движка', authed === true)
  const version = await client.request('/api/v2/app/version').then(r => r.text())
  check('версия через клиент с логином', Boolean(version), version.trim())

  const torrentCount = await client.list()
  check('список торрентов доступен', Array.isArray(torrentCount), { count: torrentCount.length })

  console.log(`\n[6] Настоящее скачивание через встроенный qBittorrent`)
  const { default: WebTorrent } = await import(path.join(ROOT, 'node_modules/webtorrent/index.js'))
  const { Server: TrackerServer } = await import(path.join(ROOT, 'node_modules/bittorrent-tracker/index.js'))

  const payload = crypto.randomBytes(600 * 1024)
  const seedPath = path.join(dataDir, 'seed', 'video.bin')
  fs.mkdirSync(path.dirname(seedPath), { recursive: true })
  fs.writeFileSync(seedPath, payload)

  const tracker = new TrackerServer({ udp: false, ws: false, stats: false })
  await new Promise(resolve => tracker.listen(0, '127.0.0.1', resolve))
  const announce = `http://127.0.0.1:${tracker.http.address().port}/announce`

  const seeder = new WebTorrent({ dht: false, lsd: false })
  const seeded = await new Promise((resolve, reject) => {
    const t = seeder.seed(seedPath, { announce: [announce] })
    t.on('error', reject)
    t.on('ready', () => resolve(t))
  })

  await client.addTorrent({ magnet: seeded.magnetURI, savePath: downloadPath })

  const downloadDeadline = Date.now() + 150000
  let snapshot = null
  while (Date.now() < downloadDeadline) {
    const list = await client.list()
    snapshot = list.find(t => t.id.toLowerCase() === seeded.infoHash.toLowerCase())
    if (snapshot && snapshot.done) break
    if (snapshot && snapshot.error) break
    await new Promise(r => setTimeout(r, 2000))
  }
  check('торрент появился в движке', Boolean(snapshot), snapshot && snapshot.name)
  check('загрузка завершена', Boolean(snapshot && snapshot.done), snapshot && { progress: snapshot.progress, state: snapshot.state })

  const outFile = path.join(downloadPath, 'video.bin')
  const contentOk = fs.existsSync(outFile) && Buffer.compare(fs.readFileSync(outFile), payload) === 0
  check('файл скачан и совпадает с оригиналом', contentOk, outFile)

  await client.remove([seeded.infoHash], true)
  await new Promise(resolve => seeder.destroy(resolve))
  await new Promise(resolve => tracker.close(resolve))

  console.log(`\n[7] Перезапуск после жёсткого завершения`)
  const pid = instance.child && instance.child.pid
  instance.killSync()
  await new Promise(r => setTimeout(r, 1200))
  let alive = false
  try { process.kill(pid, 0); alive = true } catch { alive = false }
  check('процесс убит', !alive, { pid })

  const restarted = await instance.start()
  check('перезапуск удался (потерянный lockfile не мешает)', Boolean(restarted), restarted)

  console.log(`\n[8] Остановка процесса`)
  const pid2 = instance.child && instance.child.pid
  await instance.stop()
  await new Promise(r => setTimeout(r, 800))
  let alive2 = false
  try { process.kill(pid2, 0); alive2 = true } catch { alive2 = false }
  check('процесс завершён', !alive2, { pid: pid2 })
  check('состояние stopped', instance.state === 'stopped')

  fs.rmSync(dataDir, { recursive: true, force: true })

  console.log(`\nИтог: успешно ${passed}, провалов ${failed}`)
  process.exit(failed ? 1 : 0)
}

main().catch(err => {
  console.error('\nОШИБКА:', err.message)
  process.exit(1)
})
