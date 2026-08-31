import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { parseIndex, planRemovals } from '../src/mrpack.mjs'
import { extractZip } from '../src/plugins.mjs'
import { UserError } from '../src/util.mjs'

// The same hand-built zip the plugin tests use, so extraction is tested against the format.
function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, text] of entries) {
    const raw = Buffer.from(text, 'utf8')
    const nameBuf = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(zlib.crc32(raw), 14)
    local.writeUInt32LE(raw.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, raw)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt32LE(zlib.crc32(raw), 16)
    central.writeUInt32LE(raw.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([central, nameBuf]))
    offset += 30 + nameBuf.length + raw.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-mrpack-'))

// ---- the index reader -------------------------------------------------------

const INDEX = {
  formatVersion: 1,
  game: 'minecraft',
  versionId: '1.2.0',
  name: 'Example Pack',
  dependencies: { minecraft: '26.2', 'fabric-loader': '0.19.3' },
  files: [
    { path: 'mods/lithium.jar', hashes: { sha1: 'a'.repeat(40) }, downloads: ['https://cdn/lith.jar'], fileSize: 10 },
    { path: 'mods/clientshader.jar', env: { server: 'unsupported' }, hashes: {}, downloads: ['https://cdn/x.jar'] },
    { path: 'config/lithium.properties', hashes: {}, downloads: ['https://cdn/c.prop'] },
  ],
}

test('a fabric pack index reduces to what the install needs', () => {
  const out = parseIndex(INDEX)
  assert.equal(out.name, 'Example Pack')
  assert.equal(out.mc, '26.2')
  assert.equal(out.fabricLoader, '0.19.3')
  assert.deepEqual(out.files.map((f) => f.path), ['mods/lithium.jar', 'config/lithium.properties'])
  assert.equal(out.skipped, 1, 'the client-only file is skipped and counted')
})

test('a pack for a loader mcctl cannot run yet is refused by name', () => {
  const neo = { ...INDEX, dependencies: { minecraft: '26.2', neoforge: '21.4.100' } }
  assert.throws(() => parseIndex(neo), /neoforge.*Fabric packs only/s)
})

test('a pack with no loader, no minecraft version, or the wrong shape is refused', () => {
  assert.throws(() => parseIndex({ game: 'minecraft', files: [], dependencies: {} }), UserError)
  assert.throws(() => parseIndex({ game: 'terraria', files: [] }), UserError)
  assert.throws(() => parseIndex({ ...INDEX, dependencies: { minecraft: '26.2' } }), UserError)
})

test('a pack file path that escapes the instance folder poisons the whole pack', () => {
  for (const bad of ['../outside.jar', '/absolute.jar', 'C:/windows/system32/evil.jar', 'mods/../../up.jar']) {
    const evil = { ...INDEX, files: [{ path: bad, hashes: {}, downloads: ['https://cdn/x'] }] }
    assert.throws(() => parseIndex(evil), UserError, `accepted "${bad}"`)
  }
})

// ---- what a pack update may delete ------------------------------------------

test('an update deletes only what the old pack owned and the new one dropped', () => {
  const old = ['mods/a-1.0.jar', 'mods/b-1.0.jar', 'config/a.toml']
  const now = ['mods/a-2.0.jar', 'mods/b-1.0.jar', 'config/a.toml']
  assert.deepEqual(planRemovals(old, now), ['mods/a-1.0.jar'])
})

test('what the person added is never a removal candidate, because it was never owned', () => {
  const old = ['mods/pack-mod.jar']
  // hand-added.jar is on disk but not in either record - it simply never appears here.
  assert.deepEqual(planRemovals(old, []), ['mods/pack-mod.jar'])
})

test('protected paths survive even a confused record', () => {
  const old = ['world/level.dat', 'world_nether/level.dat', 'server.properties', 'mods/old.jar', 'eula.txt']
  const removals = planRemovals(old, [], { protect: ['world', 'world_nether', 'server.properties', 'eula.txt'] })
  assert.deepEqual(removals, ['mods/old.jar'])
})

test('a protected prefix guards the directory, not every name that starts with it', () => {
  const removals = planRemovals(['worldedit/config.yml', 'world/level.dat'], [], { protect: ['world'] })
  assert.deepEqual(removals, ['worldedit/config.yml'])
})

test('path tricks in a record never become deletions', () => {
  const old = ['../outside.jar', '/absolute.jar', 'mods/../../up.jar', 'mods\\windows-style.jar']
  const removals = planRemovals(old, [])
  assert.deepEqual(removals, ['mods/windows-style.jar'], 'backslashes normalise; escapes are dropped')
})

// ---- extraction -------------------------------------------------------------

test('overrides extract with their prefix stripped and everything else left behind', () => {
  const dir = scratch()
  const file = path.join(dir, 'pack.mrpack')
  fs.writeFileSync(file, buildZip([
    ['modrinth.index.json', '{}'],
    ['overrides/config/mod.toml', 'setting = true'],
    ['overrides/mods/', ''],
    ['server-overrides/server-only.txt', 'server'],
  ]))
  const dest = path.join(dir, 'out')
  const strip = (p) => (n) => (n.startsWith(p) ? n.slice(p.length) : null)
  const laid = extractZip(file, dest, { mapPath: strip('overrides/') })
  assert.deepEqual(laid, ['config/mod.toml'])
  assert.equal(fs.readFileSync(path.join(dest, 'config', 'mod.toml'), 'utf8'), 'setting = true')
  assert.ok(!fs.existsSync(path.join(dest, 'modrinth.index.json')), 'the index is not an override')
  const laidServer = extractZip(file, dest, { mapPath: strip('server-overrides/') })
  assert.deepEqual(laidServer, ['server-only.txt'])
})

test('a zip entry that tries to climb out of the destination stops the extraction', () => {
  const dir = scratch()
  const file = path.join(dir, 'evil.zip')
  fs.writeFileSync(file, buildZip([['../escape.txt', 'gotcha']]))
  const dest = path.join(dir, 'out')
  fs.mkdirSync(dest)
  assert.throws(() => extractZip(file, dest), /outside its folder/)
  assert.ok(!fs.existsSync(path.join(dir, 'escape.txt')), 'nothing was written outside dest')
})
