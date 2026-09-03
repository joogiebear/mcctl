import test from 'node:test'
import assert from 'node:assert/strict'

import { cleanLabel, slugFor } from '../src/util.mjs'

test('a label is kept as typed, with whitespace collapsed and control characters dropped', () => {
  assert.equal(cleanLabel('  Survival   (Season 3) '), 'Survival (Season 3)')
  assert.equal(cleanLabel('tab\there'), 'tab here')
  assert.equal(cleanLabel('bell\u0007'), 'bell')
  assert.equal(cleanLabel('x'.repeat(60)).length, 48)
})

test('an empty or blank label is null, so the name stands in', () => {
  assert.equal(cleanLabel(''), null)
  assert.equal(cleanLabel('   '), null)
  assert.equal(cleanLabel(null), null)
  assert.equal(cleanLabel(undefined), null)
})

test('the name derived from a label holds only what a name may hold', () => {
  assert.equal(slugFor('Survival (Season 3)'), 'Survival-Season-3')
  assert.equal(slugFor('  my   server  '), 'my-server')
  assert.equal(slugFor('already_fine-1'), 'already_fine-1')
  assert.equal(slugFor('--dashes--'), 'dashes')
  assert.equal(slugFor('ünïcödé name'), 'n-c-d-name')
})

test('a label with nothing usable in it still yields a name', () => {
  assert.equal(slugFor('!!!'), 'server')
  assert.equal(slugFor(''), 'server')
})

test('the derived name never exceeds the 32-character limit and never ends in a dash', () => {
  const long = slugFor('a very long server name that goes on and on and on')
  assert.ok(long.length <= 32, long)
  assert.ok(!/[-_]$/.test(long), long)
  assert.match(long, /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/)
})
