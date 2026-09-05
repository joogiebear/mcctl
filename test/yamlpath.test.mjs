/** The comment-preserving YAML editor the config helpers write with. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { setYamlValues, scalar } from '../src/yamlpath.mjs'

const LUCKPERMS = `# LuckPerms configuration
# https://luckperms.net/wiki/Configuration

# How the plugin should store data.
storage-method: h2

# The following block defines the settings for remote database storage methods.
data:
  # Define the address and port for the database.
  address: localhost

  # The name of the database to store LuckPerms data in.
  database: minecraft

  # Credentials for the database.
  username: root
  password: ''

  # These settings apply to the MySQL connection pool.
  pool-settings:
    maximum-pool-size: 10

# Other settings
sync-minutes: -1
`

test('values change in place; comments, blank lines and order survive; strings are quoted', () => {
  const { text, written, inserted } = setYamlValues(LUCKPERMS, [
    { path: ['storage-method'], value: 'mariadb' },
    { path: ['data', 'address'], value: '127.0.0.1:3307' },
    { path: ['data', 'password'], value: "it's" },
  ])
  assert.deepEqual(written, ['storage-method', 'data.address', 'data.password'])
  assert.deepEqual(inserted, [])
  assert.match(text, /^storage-method: 'mariadb'$/m)
  assert.match(text, /^  address: '127\.0\.0\.1:3307'$/m)
  assert.match(text, /^  password: 'it''s'$/m)
  assert.match(text, /^  database: minecraft$/m, 'an untouched key must keep its value')
  assert.match(text, /^# How the plugin should store data\.$/m)
  assert.match(text, /^    maximum-pool-size: 10$/m)
  assert.equal(text.split('\n').length, LUCKPERMS.split('\n').length, 'no line added or lost')
})

test('a trailing comment on the line stays, and numbers and booleans are bare', () => {
  const doc = 'use-mysql: false # flip this to use MySQL\nmysql-port: 3306\nname: "quoted # not a comment" # real comment\n'
  const { text } = setYamlValues(doc, [
    { path: ['use-mysql'], value: true },
    { path: ['mysql-port'], value: 3307 },
    { path: ['name'], value: 'x' },
  ])
  assert.equal(text, "use-mysql: true # flip this to use MySQL\nmysql-port: 3307\nname: 'x' # real comment\n")
})

test('a key that is missing is added under its parent at the parent\'s indent, at the end of the block', () => {
  const doc = 'Database:\n    Type: SQLite\n    MySQL:\n        Host: localhost\n\n# Next section\nServer:\n    Name: x\n'
  const { text, inserted } = setYamlValues(doc, [
    { path: ['Database', 'MySQL', 'Port'], value: 3306 },
    { path: ['Database', 'Fresh', 'Key'], value: 'v' },
  ])
  assert.deepEqual(inserted, ['Database.MySQL.Port', 'Database.Fresh.Key'])
  const lines = text.split('\n')
  assert.equal(lines[3], '        Host: localhost')
  assert.equal(lines[4], '        Port: 3306', 'sits inside MySQL at its four-space indent')
  assert.equal(lines[5], '    Fresh:')
  assert.equal(lines[6], "      Key: 'v'")
  assert.equal(lines[7], '', 'the blank line before the next section is still where it was')
  assert.equal(lines[8], '# Next section')
})

test('a top-level key that is missing goes at the end; CRLF files stay CRLF', () => {
  const { text } = setYamlValues('a: 1\r\nb: 2\r\n', [{ path: ['c'], value: 'three' }])
  assert.equal(text, "a: 1\r\nb: 2\r\nc: 'three'\r\n")
})

test('the same key at a deeper level is not mistaken for the one wanted', () => {
  const doc = 'outer:\n  port: 1\nport: 2\n'
  const { text } = setYamlValues(doc, [{ path: ['port'], value: 9 }])
  assert.equal(text, 'outer:\n  port: 1\nport: 9\n')
})

test('scalar quoting', () => {
  assert.equal(scalar(true), 'true')
  assert.equal(scalar(3306), '3306')
  assert.equal(scalar("a'b"), "'a''b'")
  assert.equal(scalar('127.0.0.1'), "'127.0.0.1'")
})
