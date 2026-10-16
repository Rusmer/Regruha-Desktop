'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const aurDir = path.join(root, 'aur')
const pkgbuildPath = path.join(aurDir, 'PKGBUILD')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const appImageName = 'Regruha-' + pkg.version + '.AppImage'
const appImagePath = path.join(root, 'release', appImageName)

if (!fs.existsSync(appImagePath)) {
  console.error('нет ' + path.relative(root, appImagePath) + ' — сначала выполните: npm run dist:linux')
  process.exit(1)
}

const sha256 = crypto.createHash('sha256').update(fs.readFileSync(appImagePath)).digest('hex')
const pkgbuild = fs.readFileSync(pkgbuildPath, 'utf8')
  .replace(/^pkgver=.*$/m, 'pkgver=' + pkg.version)
  .replace(/^sha256sums=\('.*'\)$/m, "sha256sums=('" + sha256 + "')")
fs.writeFileSync(pkgbuildPath, pkgbuild)

const linkPath = path.join(aurDir, appImageName)
try {
  fs.unlinkSync(linkPath)
} catch (e) {}
fs.symlinkSync(path.join('..', 'release', appImageName), linkPath)

console.log('pkgver=' + pkg.version + '  sha256=' + sha256)
console.log('источник: aur/' + appImageName + ' -> ../release/' + appImageName)

const build = spawnSync('makepkg', ['-f', '-c'], { cwd: aurDir, stdio: 'inherit' })
if (build.status !== 0) process.exit(build.status === null ? 1 : build.status)

const srcinfo = spawnSync('makepkg', ['--printsrcinfo'], { cwd: aurDir, encoding: 'utf8' })
if (srcinfo.status === 0) {
  fs.writeFileSync(path.join(aurDir, '.SRCINFO'), srcinfo.stdout)
}

const built = fs.readdirSync(aurDir).filter(f => f.startsWith(pkg.name + '-') && f.endsWith('.pkg.tar.zst'))
for (const file of built) {
  const size = fs.statSync(path.join(aurDir, file)).size
  console.log('пакет: aur/' + file + '  ' + (size / 1048576).toFixed(1) + ' МиБ')
}
console.log('установка: sudo pacman -U aur/' + (built[0] || (pkg.name + '-' + pkg.version + '-1-x86_64.pkg.tar.zst')))
