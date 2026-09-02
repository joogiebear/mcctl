import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseMajor, probe, discover, defaultJava, health, MINIMUM_MAJOR } from '../src/java.mjs'

test('the major version is read from both shapes java -version has used', () => {
  assert.equal(parseMajor('openjdk version "21.0.5" 2024-10-15'), 21)
  assert.equal(parseMajor('java version "1.8.0_401"'), 8)
  assert.equal(parseMajor('openjdk version "25" 2026-09-16'), 25)
  assert.equal(parseMajor('nothing here'), null)
})

test('a java that is not there answers not-installed rather than throwing', async () => {
  const res = await probe('no-such-java-binary-for-mcctl-tests')
  assert.equal(res.ok, false)
  assert.equal(res.found, false)
  assert.equal(res.reason, 'not-installed')
})

// Discovery must never depend on PATH alone, and must agree with itself: the default is one of
// the Javas it found, and the health answer names the same one.
test('discovery, the default and health agree on the same Java', async () => {
  const { best, onPath, all } = await discover()
  for (const j of all) assert.ok(Number.isInteger(j.major), `${j.path} has a major version`)
  const chosen = await defaultJava()
  const state = await health()
  if (!best) {
    assert.equal(chosen, null)
    assert.equal(state.ok, false)
    return
  }
  assert.ok(best.major >= MINIMUM_MAJOR)
  assert.ok(all.some((j) => j.path === best.path))
  // 'java' stands for the PATH one only when PATH really has the best major.
  if (chosen === 'java') assert.equal(onPath.major, best.major)
  else assert.equal(chosen, best.path)
  assert.equal(state.path, best.path)
  assert.equal(state.onPath, best.path === 'java')
})
