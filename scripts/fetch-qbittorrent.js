'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

const { RELEASE, ASSETS, WINDOWS } = require('../src/main/qbittorrent-managed.js')

const BASE_URL = process.env.REGRUHA_QB_BASE_URL ||
  'https://github.com/userdocs/qbittorrent-nox-static/releases/download'

const ROOT = path.resolve(__dirname, '..')
const VENDOR = path.join(ROOT, 'vendor', 'qbittorrent')

async function download (url, target, expectedSha) {
  console.log(`качаю ${url}`)

  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`сервер вернул ${response.status}`)
  }

  const total = Number(response.headers.get('content-length')) || 0
  const partial = `${target}.part`
  const handle = await fs.promises.open(partial, 'w')
  let received = 0
  let shown = 0
  try {
    for await (const chunk of response.body) {
      await handle.write(chunk)
      received += chunk.length
      if (total && Date.now() - shown > 1000) {
        shown = Date.now()
        const percent = Math.round((received / total) * 100)
        process.stdout.write(`\r  ${percent}% (${(received / 1024 / 1024).toFixed(1)} МБ)`)
      }
    }
  } finally {
    await handle.close()
  }
  if (total) process.stdout.write('\r')

  if (total && received !== total) {
    await fs.promises.rm(partial, { force: true })
    throw new Error('загрузка оборвалась')
  }

  if (expectedSha) {
    const actual = await sha256(partial)
    if (actual !== expectedSha) {
      await fs.promises.rm(partial, { force: true })
      throw new Error(`не совпал SHA-256 (ожидался ${expectedSha}, получен ${actual})`)
    }
  }

  await fs.promises.rename(partial, target)
}

function sha256 (file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('error', reject)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function extractEntries (archive, dir, entries) {
  for (const tool of ['7z', '7za', '7zr']) {
    const result = spawnSync(tool, ['x', '-y', `-o${dir}`, archive, ...entries], { stdio: 'ignore' })
    if (result.error && result.error.code === 'ENOENT') continue
    if (result.status === 0) return true
    throw new Error(`не удалось распаковать установщик (7-Zip вернул код ${result.status})`)
  }
  throw new Error('нужен 7-Zip (команда 7z или 7za), чтобы достать qbittorrent.exe из установщика')
}

async function fetchLinuxNox (key) {
  const asset = ASSETS[key]
  if (!asset) {
    throw new Error(`нет сборки для «${key}» (доступно: ${[...Object.keys(ASSETS), 'win-x64'].join(', ')})`)
  }

  const dir = path.join(VENDOR, key)
  const target = path.join(dir, 'qbittorrent-nox')
  if (fs.existsSync(target)) {
    console.log(`уже есть: ${path.relative(ROOT, target)}`)
    return
  }

  fs.mkdirSync(dir, { recursive: true })
  await download(`${BASE_URL}/${RELEASE}/${asset}`, target)
}

async function fetchWindows () {
  const dir = path.join(VENDOR, WINDOWS.key)
  const target = path.join(dir, 'qbittorrent.exe')
  if (fs.existsSync(target)) {
    console.log(`уже есть: ${path.relative(ROOT, target)}`)
    return
  }

  const tmp = path.join(os.tmpdir(), `regruha-qbittorrent-${WINDOWS.version}-setup.exe`)
  try {
    await download(WINDOWS.url, tmp, WINDOWS.sha256)
    fs.mkdirSync(dir, { recursive: true })
    extractEntries(tmp, dir, ['qbittorrent.exe'])
    try {
      extractEntries(tmp, dir, ['qt.conf'])
    } catch {   }
  } finally {
    fs.rmSync(tmp, { force: true })
  }

  if (!fs.existsSync(target)) {
    throw new Error('в установщике не найден qbittorrent.exe')
  }
  console.log(`готово: ${path.relative(ROOT, target)}`)
}

function normalizeKey (key) {
  const value = String(key).toLowerCase()
  if (['win', 'win-x64', 'win32-x64', 'win32', 'windows', 'windows-x64'].includes(value)) {
    return WINDOWS.key
  }
  return key
}

async function fetchKey (key) {
  return key === WINDOWS.key ? fetchWindows() : fetchLinuxNox(key)
}

async function main () {
  const requested = process.argv.slice(2)
  const keys = (requested.length ? requested : [`${process.platform}-${process.arch}`]).map(normalizeKey)

  for (const key of keys) {
    try {
      await fetchKey(key)
    } catch (err) {
      console.error(`ошибка для ${key}: ${err.message}`)
      process.exitCode = 1
    }
  }
}

main()
