import { test } from 'node:test'
import assert from 'node:assert/strict'

import { crashVerdict, CRASH_LIMIT, CRASH_WINDOW_MS, RESTART_DELAY_MS } from '../src/crashguard.mjs'

const NOW = 1_000_000_000

test('a requested stop stays stopped, whatever the exit code', () => {
  assert.equal(crashVerdict({ enabled: true, stopping: true, code: 137, signal: null, crashes: [NOW], now: NOW }).kind, 'stay-down')
})

test('a clean exit stays stopped - "stop" typed into the console never passes through the daemon', () => {
  assert.equal(crashVerdict({ enabled: true, stopping: false, code: 0, signal: null, crashes: [], now: NOW }).kind, 'stay-down')
})

test('a crash with auto-restart off stays down', () => {
  assert.equal(crashVerdict({ enabled: false, stopping: false, code: 1, signal: null, crashes: [NOW], now: NOW }).kind, 'stay-down')
})

test('a crash with auto-restart on comes back after the delay', () => {
  const v = crashVerdict({ enabled: true, stopping: false, code: 1, signal: null, crashes: [NOW], now: NOW })
  assert.equal(v.kind, 'restart')
  assert.equal(v.delayMs, RESTART_DELAY_MS)
})

test('a kill by signal counts as a crash even when the code is null', () => {
  const v = crashVerdict({ enabled: true, stopping: false, code: null, signal: 'SIGKILL', crashes: [NOW], now: NOW })
  assert.equal(v.kind, 'restart')
})

test('the limit-th crash inside the window gives up; one outside the window does not count', () => {
  const inside = Array.from({ length: CRASH_LIMIT }, (_, i) => NOW - i * 1000)
  assert.equal(crashVerdict({ enabled: true, stopping: false, code: 1, signal: null, crashes: inside, now: NOW }).kind, 'give-up')

  const spread = [NOW - CRASH_WINDOW_MS - 1000, NOW - 5000, NOW]
  const v = crashVerdict({ enabled: true, stopping: false, code: 1, signal: null, crashes: spread, now: NOW })
  assert.equal(v.kind, 'restart')
  assert.equal(v.recent, CRASH_LIMIT - 1)
})
