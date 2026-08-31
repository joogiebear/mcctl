import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parsePaperJar, newerVersionsOf } from '../src/upgrade.mjs'

test('a Paper jar name yields its version and build', () => {
  assert.deepEqual(parsePaperJar('paper-26.2-121.jar'), { version: '26.2', build: 121 })
  assert.deepEqual(parsePaperJar('paper-1.21.4-2140.jar'), { version: '1.21.4', build: 2140 })
})

test('anything else yields null rather than a guess', () => {
  for (const bad of ['purpur-26.2-100.jar', 'custom.jar', 'paper-26.2.jar', '', null]) {
    assert.equal(parsePaperJar(bad), null, `parsed "${bad}"`)
  }
})

test('newer versions are the ones before the current in the newest-first list', () => {
  const all = ['26.3', '26.2', '26.1', '25.4']
  assert.deepEqual(newerVersionsOf(all, '26.2'), ['26.3'])
  assert.deepEqual(newerVersionsOf(all, '26.3'), [])
  // A version Paper never published gets no "newer than" claim at all.
  assert.deepEqual(newerVersionsOf(all, '9.9'), [])
})
