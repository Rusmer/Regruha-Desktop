'use strict'

const { execFile } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const ROOT = path.resolve(__dirname, '..')
const ARG = process.argv[2]
const ENGINE = ARG === 'qbittorrent' ? 'qbittorrent' : 'managed'
const ENGINE_ID = ENGINE === 'qbittorrent' ? 'qbittorrent' : 'qbittorrent-managed'

async function main () {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regruha-smoke-'))
  const payload = path.join(outDir, 'payload.bin')
  fs.writeFileSync(payload, Buffer.alloc(2 * 1024 * 1024, 0x2a))

  const { default: createTorrent } = await import(path.join(ROOT, 'node_modules/create-torrent/index.js'))
  const torrentBuf = await new Promise((resolve, reject) => {
    createTorrent(payload, {
      name: 'Regruha Test Movie',
      announceList: [['http://127.0.0.1:9/announce']]
    }, (err, data) => err ? reject(err) : resolve(data))
  })
  const torrentPath = path.join(outDir, 'test.torrent')
  fs.writeFileSync(torrentPath, torrentBuf)

  const userData = path.join(outDir, 'userdata')
  const outBase = path.join(outDir, 'shot')
  const electron = require('electron')

  const { binaryName } = require(path.join(ROOT, 'src/main/qbittorrent-managed.js'))
  const vendorBinary = path.join(ROOT, 'vendor', 'qbittorrent', `${process.platform}-${process.arch}`, binaryName())
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    engine: ENGINE_ID,
    downloadPath: path.join(outDir, 'selftest-data', 'downloads'),
    askForTorrentFiles: true,
    revealAfterOpen: true,
    qbittorrent: {
      url: process.env.REGRUHA_SELFTEST_QB_URL || 'http://127.0.0.1:8080',
      username: process.env.REGRUHA_SELFTEST_QB_USER || 'admin',
      password: process.env.REGRUHA_SELFTEST_QB_PASSWORD || 'adminadmin'
    }
  }, null, 2))

  console.log(`[smoke] каталог теста: ${outDir}`)
  console.log(`[smoke] движок: ${ENGINE}`)

  const child = execFile(electron, ['.', '--no-sandbox', `--user-data-dir=${userData}`], {
    cwd: ROOT,
    timeout: 240000,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      REGRUHA_SELFTEST: outBase,
      REGRUHA_SELFTEST_TORRENT: torrentPath,
      REGRUHA_SELFTEST_ENGINE: ENGINE,
      REGRUHA_QB_BINARY: fs.existsSync(vendorBinary) ? vendorBinary : process.env.REGRUHA_QB_BINARY,
      REGRUHA_SELFTEST_QB_URL: process.env.REGRUHA_SELFTEST_QB_URL || 'http://127.0.0.1:8080',
      REGRUHA_SELFTEST_QB_USER: process.env.REGRUHA_SELFTEST_QB_USER || 'admin',
      REGRUHA_SELFTEST_QB_PASSWORD: process.env.REGRUHA_SELFTEST_QB_PASSWORD || 'adminadmin',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
    }
  }, (err, stdout, stderr) => {
    const lines = String(stdout).split('\n').filter(line => line.includes('[selftest]') || line.includes('[smoke]'))
    console.log(lines.join('\n'))

    const failures = lines.filter(line => line.includes('[selftest] FAIL'))
    const total = lines.filter(line => line.includes('[selftest] OK') || line.includes('[selftest] FAIL')).length

    console.log(`\n[smoke] проверок: ${total}, провалов: ${failures.length}`)

    if (err && err.code && !child.killed) console.log(`[smoke] код завершения процесса: ${err.code}`)

    const fatal = String(stderr).split('\n').filter(line =>
      /\[selftest\] ОШИБКА|Uncaught |TypeError:|ReferenceError:/.test(line)
    )
    if (fatal.length) console.log(`[smoke] фатальные строки:\n${fatal.slice(0, 10).join('\n')}`)

    const shots = fs.readdirSync(outDir).filter(file => file.endsWith('.png'))
    console.log(`[smoke] скриншоты: ${shots.map(file => path.join(outDir, file)).join(', ') || 'нет'}`)

    process.exit(failures.length || fatal.length ? 1 : 0)
  })

  child.on('error', error => {
    console.error('[smoke] не удалось запустить Electron:', error.message)
    process.exit(1)
  })
}

main().catch(error => {
  console.error('[smoke] ОШИБКА:', error.message)
  process.exit(1)
})
