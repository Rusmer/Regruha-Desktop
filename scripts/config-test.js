'use strict'

const crypto = require('node:crypto')
const path = require('node:path')

const modulePath = path.join(__dirname, '..', 'src', 'main', 'qbittorrent-managed.js')

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
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

function loadFor (platform) {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform })
  delete require.cache[require.resolve(modulePath)]
  const mod = require(modulePath)
  Object.defineProperty(process, 'platform', platformDescriptor)
  return mod
}

let failed = 0

function check (name, condition, detail) {
  const ok = Boolean(condition)
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}

console.log('Конфигурация Linux:')
const linux = loadFor('linux')
check('файл настроек — qBittorrent.conf', linux.configFileName() === 'qBittorrent.conf', linux.configFileName())
const linuxConf = linux.buildConfig({
  port: 12345,
  savePath: '/home/user/Regruha/downloads',
  torrentPort: 51413,
  password: 'linux-secret'
})
check('WebUI включён', /WebUI\\Enabled=true/.test(linuxConf))
check('WebUI только на 127.0.0.1', /WebUI\\Address=127\.0\.0\.1/.test(linuxConf))
check('UPnP выключен (ключ UseUPnP)', /WebUI\\UseUPnP=false/.test(linuxConf))
check('логин WebUI задан', /WebUI\\Username=admin/.test(linuxConf))
check('пароль WebUI задан (PBKDF2) и верен', passwordMatches(linuxConf, 'linux-secret'))
check('нет секции [GUI]', !/\[GUI\]/.test(linuxConf))
check('путь к папке загрузок', /Session\\DefaultSavePath=\/home\/user\/Regruha\/downloads/.test(linuxConf))

console.log('\nКонфигурация Windows:')
const windows = loadFor('win32')
check('файл настроек — qBittorrent.ini', windows.configFileName() === 'qBittorrent.ini', windows.configFileName())
check('другое расширение убирается', /qBittorrent\.conf$/.test(windows.alternativeConfigFileName()), windows.alternativeConfigFileName())
const winConf = windows.buildConfig({
  port: 12345,
  savePath: 'C:\\Users\\Test User\\AppData\\Roaming\\Regruha\\downloads',
  torrentPort: 51413,
  password: 'windows-secret'
})
check('WebUI включён', /WebUI\\Enabled=true/.test(winConf))
check('WebUI только на 127.0.0.1', /WebUI\\Address=127\.0\.0\.1/.test(winConf))
check('логин WebUI задан', /WebUI\\Username=admin/.test(winConf))
check('пароль WebUI задан (PBKDF2) и верен', passwordMatches(winConf, 'windows-secret'))
check('окно скрыто', /\[GUI\][\s\S]*StartUpWindowState=Hidden/.test(winConf))
check('значок в трее включён', /General\\SystrayEnabled=true/.test(winConf))
check('проверка обновлений выключена', /Advanced\\updateCheck=false/.test(winConf))
check('UPnP выключен (ключ UseUPnP)', /WebUI\\UseUPnP=false/.test(winConf))
check('нет устаревшего ключа WebUI\\UPnP', !/WebUI\\UPnP=/.test(winConf))
check(
  'пути записаны через прямой слэш',
  /Session\\DefaultSavePath=C:\/Users\/Test User\/AppData\/Roaming\/Regruha\/downloads/.test(winConf) && !/C:\\\\Users/.test(winConf)
)

console.log(`\nПровалов: ${failed}`)
process.exit(failed ? 1 : 0)
