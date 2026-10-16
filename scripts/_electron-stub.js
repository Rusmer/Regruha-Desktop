'use strict'

const os = require('node:os')
const path = require('node:path')

let userData = path.join(os.tmpdir(), 'regruha-stub-userdata')

module.exports = {
  app: {
    getPath: name => (name === 'userData' ? userData : os.tmpdir()),
    getVersion: () => '0.0.0-test',
    getName: () => 'Regruha'
  }
}
