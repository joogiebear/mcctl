/** The pure parts of the Garnet engine: reading GitHub's release list. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { releasesFrom, windowsZipFrom, credentialsFor, newRecord } from '../src/garnet.mjs'

const rel = (tag, assets, extra = {}) => ({ tag_name: tag, published_at: '2026-08-01T00:00:00Z', assets, ...extra })

test('the self-contained Windows zip is preferred, and a release without one is skipped', () => {
  const a = [
    { name: 'garnet-linux-x64-based-readytorun.zip', browser_download_url: 'l', size: 1 },
    { name: 'garnet-win-x64-framework-dependent.zip', browser_download_url: 'fd', size: 2 },
    { name: 'garnet-win-x64-based-readytorun.zip', browser_download_url: 'w', size: 3, digest: 'sha256:abc' },
  ]
  assert.deepEqual(windowsZipFrom(rel('v1.0.70', a)), { name: 'garnet-win-x64-based-readytorun.zip', url: 'w', sha256: 'abc', size: 3 })
  assert.equal(windowsZipFrom(rel('v1', [a[0]])), null)
  const list = releasesFrom([rel('v1.0.70', a), rel('v1.0.71-rc', a, { prerelease: true }), rel('v1.0.60', [a[0]]), rel('draft', a, { draft: true })])
  assert.deepEqual(list.map((r) => r.version), ['1.0.70'])
  assert.equal(releasesFrom([rel('v1.0.71-rc', a, { prerelease: true })], { includeUnstable: true })[0].status, 'Pre-release')
})

test('an attachment shares the password and suggests a key prefix; the URL carries the password', () => {
  const inst = { port: 6380, root: { password: 'p@ss' } }
  const rec = newRecord('smp', inst)
  assert.equal(rec.database, null)
  assert.equal(rec.password, 'p@ss')
  assert.equal(rec.keyPrefix, 'smp:')
  const c = credentialsFor(inst, rec)
  assert.equal(c.url, 'redis://:p%40ss@127.0.0.1:6380')
  assert.match(c.note, /shares this password/)
})
