import { test } from 'node:test'
import assert from 'node:assert/strict'

import { formatDiscord, acceptableWebhook, notifyInstance } from '../src/notify.mjs'

test('the Discord payload names the server and carries the message in content', () => {
  assert.deepEqual(formatDiscord('stock', 'crashed (exit 1). Restarting in 10s.'),
    { content: '**stock** — crashed (exit 1). Restarting in 10s.' })
})

test('only http(s) URLs are acceptable webhooks', () => {
  assert.equal(acceptableWebhook('https://discord.com/api/webhooks/1/abc'), true)
  assert.equal(acceptableWebhook('http://127.0.0.1:9999/hook'), true)
  for (const bad of ['discord.com/api/webhooks/1/abc', 'file:///c:/x', 'javascript:alert(1)', '', null]) {
    assert.equal(acceptableWebhook(bad), false, `accepted "${bad}"`)
  }
})

test('no webhook configured means no request and a quiet false', async () => {
  assert.equal(await notifyInstance({ name: 'x' }, 'hello'), false)
  assert.equal(await notifyInstance(null, 'hello'), false)
})

test('an unreachable webhook is logged and swallowed, never thrown', async () => {
  const lines = []
  const ok = await notifyInstance(
    { name: 'x', webhook: 'http://127.0.0.1:1/nothing-listens-here' },
    'hello',
    { log: (l) => lines.push(l) },
  )
  assert.equal(ok, false)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /webhook failed/)
})
