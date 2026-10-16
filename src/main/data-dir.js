'use strict'

const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

let cached = null

function portableRoot () {
  if (process.env.REGRUHA_PORTABLE) {
    return path.join(path.dirname(app.getPath('exe')), 'regruha-data')
  }
  try {
    const marker = path.join(path.dirname(app.getPath('exe')), 'portable')
    if (fs.existsSync(marker)) {
      return path.join(path.dirname(app.getPath('exe')), 'regruha-data')
    }
  } catch {   }
  return null
}

function isPortable () {
  return Boolean(portableRoot())
}

function dataDir () {
  if (cached) return cached
  const root = portableRoot()
  cached = root || app.getPath('userData')
  try {
    fs.mkdirSync(cached, { recursive: true })
  } catch {   }
  return cached
}

module.exports = { dataDir, isPortable }
