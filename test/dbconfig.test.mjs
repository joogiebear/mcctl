/** The config helpers: which plugins they see, and what they write. */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { HELPERS, detectHelpers, applyHelper } from '../src/dbconfig.mjs'
import { UserError } from '../src/util.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-dbconfig-'))
const inst = { name: 'smp', dir }
after(() => fs.rmSync(dir, { recursive: true, force: true }))

const creds = { host: '127.0.0.1', port: 3307, database: 'smp', user: 'smp', password: 'p4ss' }

test('every helper names a real file under plugins/ and edits at least the connection keys', () => {
  for (const h of HELPERS) {
    assert.match(h.file, /^plugins\/[^/]+\/config\.yml$/)
    const edits = h.edits(creds)
    const joined = edits.map((e) => `${e.path.join('.')}=${e.value}`).join(' ')
    assert.ok(/p4ss/.test(joined), `${h.id} does not write the password`)
    assert.ok(/smp/.test(joined), `${h.id} does not write the database`)
  }
})

test('nothing installed: every helper reports absent, and apply refuses with the way out', () => {
  const seen = detectHelpers(inst)
  assert.equal(seen.length, HELPERS.length)
  assert.ok(seen.every((h) => !h.pluginPresent && !h.configPresent))
  assert.throws(() => applyHelper(inst, 'luckperms', creds), /has not written its config yet/)
  assert.throws(() => applyHelper(inst, 'nope', creds), UserError)
})

test('CoreProtect: the config it ships is switched to MySQL with the comments intact', () => {
  fs.mkdirSync(path.join(dir, 'plugins', 'CoreProtect'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'plugins', 'CoreProtect', 'config.yml'), [
    '# CoreProtect is donationware. Obtain a donation key from https://coreprotect.net/donate/',
    'donation-key:',
    '',
    '# MySQL support. Set use-mysql to true to enable.',
    'use-mysql: false',
    'table-prefix: co_',
    'mysql-host: 127.0.0.1',
    'mysql-port: 3306',
    'mysql-database: database',
    'mysql-username: root',
    'mysql-password: ',
    '',
    '# Logging settings',
    'rollback-items: true',
    '',
  ].join('\n'))
  const res = applyHelper(inst, 'coreprotect', creds)
  assert.deepEqual(res.written, ['use-mysql', 'mysql-host', 'mysql-port', 'mysql-database', 'mysql-username', 'mysql-password'])
  assert.deepEqual(res.inserted, [])
  const text = fs.readFileSync(path.join(dir, 'plugins', 'CoreProtect', 'config.yml'), 'utf8')
  assert.match(text, /^use-mysql: true$/m)
  assert.match(text, /^mysql-port: 3307$/m)
  assert.match(text, /^mysql-password: 'p4ss'$/m)
  assert.match(text, /^table-prefix: co_$/m)
  assert.match(text, /^# MySQL support\. Set use-mysql to true to enable\.$/m)
  assert.match(text, /^rollback-items: true$/m)
})

test('AuthMe: a four-space nested block, with the port written as the string it expects', () => {
  fs.mkdirSync(path.join(dir, 'plugins', 'AuthMe'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'plugins', 'AuthMe', 'config.yml'), [
    'DataSource:',
    "    # What type of database do you want to use?",
    '    backend: SQLITE',
    '    caching: true',
    "    mySQLHost: '127.0.0.1'",
    "    mySQLPort: '3306'",
    '    mySQLUsername: authme',
    "    mySQLPassword: '12345'",
    '    mySQLDatabase: authme',
    '    mySQLTablename: authme',
    'settings:',
    '    sessions:',
    '        enabled: false',
    '',
  ].join('\n'))
  const res = applyHelper(inst, 'authme', creds)
  assert.equal(res.inserted.length, 0)
  const text = fs.readFileSync(path.join(dir, 'plugins', 'AuthMe', 'config.yml'), 'utf8')
  assert.match(text, /^    backend: 'MYSQL'$/m)
  assert.match(text, /^    mySQLPort: '3307'$/m)
  assert.match(text, /^    mySQLTablename: authme$/m)
  assert.match(text, /^        enabled: false$/m)
})

test('a plugin whose config lacks a key gets it added inside the right block', () => {
  fs.mkdirSync(path.join(dir, 'plugins', 'Plan'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'plugins', 'Plan', 'config.yml'), 'Database:\n  Type: SQLite\n  MySQL:\n    Host: localhost\nPlugin:\n  Logging: true\n')
  const res = applyHelper(inst, 'plan', creds)
  assert.ok(res.inserted.includes('Database.MySQL.Port'))
  assert.ok(res.inserted.includes('Database.MySQL.Database'))
  const text = fs.readFileSync(path.join(dir, 'plugins', 'Plan', 'config.yml'), 'utf8')
  const lines = text.split('\n')
  const mysqlAt = lines.indexOf('  MySQL:')
  const pluginAt = lines.indexOf('Plugin:')
  for (const k of ['    Port: 3307', "    User: 'smp'", "    Password: 'p4ss'", "    Database: 'smp'"]) {
    const at = lines.indexOf(k)
    assert.ok(at > mysqlAt && at < pluginAt, `${k} is not inside the MySQL block`)
  }
  assert.match(text, /^  Type: 'MySQL'$/m)
})

test('detect reports a config that exists, and does not confuse one plugin with another', () => {
  const seen = detectHelpers(inst)
  assert.equal(seen.find((h) => h.id === 'coreprotect').configPresent, true)
  assert.equal(seen.find((h) => h.id === 'luckperms').configPresent, false)
})
