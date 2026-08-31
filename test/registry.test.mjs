import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseMemoryGb, jvmFlagsFor } from '../src/registry.mjs'
import { UserError } from '../src/util.mjs'

test('memory strings resolve to gigabytes whichever unit they use', () => {
  assert.equal(parseMemoryGb('4G'), 4)
  assert.equal(parseMemoryGb('4g'), 4)
  assert.equal(parseMemoryGb('6144M'), 6)
  assert.equal(parseMemoryGb('0.5G'), 0.5)
  assert.equal(parseMemoryGb(' 2G '), 2)
})

test('a memory string with no unit, or a typo, is refused', () => {
  for (const bad of ['4', '*G', 'G4', '4GB', '', 'four gigs']) {
    assert.throws(() => parseMemoryGb(bad), UserError, `accepted "${bad}"`)
  }
})

// The young-gen sizing that works for 4G starves a big heap, so the flags change at 12G.
test('the JVM flags switch to the large-heap variant at 12G', () => {
  assert.ok(jvmFlagsFor('4G').includes('-XX:G1HeapRegionSize=8M'))
  assert.ok(jvmFlagsFor('11G').includes('-XX:G1HeapRegionSize=8M'))
  assert.ok(jvmFlagsFor('12G').includes('-XX:G1HeapRegionSize=16M'))
  assert.ok(jvmFlagsFor('16384M').includes('-XX:G1HeapRegionSize=16M'))
})
