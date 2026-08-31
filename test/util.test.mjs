import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  humanBytes, humanDuration, table, validateName, stamp, randomPassword,
  readJson, writeJson, UserError,
} from '../src/util.mjs'

test('bytes read at the right unit, whole below 1 KB', () => {
  assert.equal(humanBytes(0), '0 B')
  assert.equal(humanBytes(1023), '1023 B')
  assert.equal(humanBytes(1536), '1.5 KB')
  assert.equal(humanBytes(111518632), '106.4 MB')
  assert.equal(humanBytes(null), '-')
})

test('durations carry the two units that matter at their scale', () => {
  assert.equal(humanDuration(5000), '5s')
  assert.equal(humanDuration(65000), '1m 5s')
  assert.equal(humanDuration(3 * 3600000 + 7 * 60000), '3h 7m')
  assert.equal(humanDuration(26 * 3600000), '1d 2h')
  assert.equal(humanDuration(null), '-')
})

test('table pads every column to its widest cell and trims row ends', () => {
  const text = table([['NAME', 'STATE'], ['stock', 'running'], ['g', 'up']])
  assert.deepEqual(text.split('\n'), ['NAME   STATE', 'stock  running', 'g      up'])
})

test('names allow letters, digits, dash, underscore, up to 32', () => {
  assert.equal(validateName('Stock_2-b'), 'Stock_2-b')
  assert.equal(validateName('a'.repeat(32)), 'a'.repeat(32))
  for (const bad of ['', '-lead', 'has space', 'a'.repeat(33), '..\\up', 'semi;colon']) {
    assert.throws(() => validateName(bad), UserError, `accepted "${bad}"`)
  }
})

test('stamp is filename-safe and zero-padded', () => {
  assert.equal(stamp(new Date(2026, 7, 30, 5, 4, 3)), '2026-08-30_050403')
})

test('passwords draw only from the unambiguous alphabet, at the asked length', () => {
  const pw = randomPassword(32)
  assert.equal(pw.length, 32)
  assert.match(pw, /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789]+$/)
})

test('readJson answers the fallback for a missing file, not an error', () => {
  assert.deepEqual(readJson(path.join(os.tmpdir(), 'mcctl-does-not-exist.json'), { a: 1 }), { a: 1 })
})

test('writeJson round-trips and leaves no .tmp behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-util-'))
  const file = path.join(dir, 'deep', 'reg.json')
  writeJson(file, { version: 1, instances: {} })
  assert.deepEqual(readJson(file), { version: 1, instances: {} })
  assert.ok(!fs.existsSync(`${file}.tmp`), 'the temp file should have been renamed away')
})
