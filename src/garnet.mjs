import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { ENGINES_DIR } from './paths.mjs'
import { runTar } from './tar.mjs'
import { respPing } from './resp.mjs'
import { GARNET_READY_RE, GARNET_FAILED_RE } from './ready.mjs'
import { fail, humanBytes } from './util.mjs'

/**
 * Garnet, for the Redis role.
 *
 * <p>Redis itself ships no Windows binary. Microsoft's Garnet speaks the Redis protocol, is MIT
 * licensed, and publishes a self-contained Windows build on its GitHub releases page - which is
 * the same feed shape this program already reads for its own updates. A plugin that wants Redis
 * for messaging or caching sees a Redis server; nothing on the plugin's side knows the difference.
 *
 * <p>Unlike MariaDB there is no per-server database or user: Redis has one password and one key
 * space, and plugins are expected to prefix their keys. So an attachment here is the same
 * credentials for every server, recorded so the panel can say who uses it.
 */

const RELEASES = 'https://api.github.com/repos/microsoft/garnet/releases?per_page=30'
const UA = 'SpawnLoft (github.com/joogiebear/spawnloft)'

export const ENGINE = 'garnet'
export const LABEL = 'Redis (Garnet)'
export const KIND = 'redis'
export const DEFAULT_PORT = 6379
export const READY_RE = GARNET_READY_RE
export const FAILED_RE = GARNET_FAILED_RE

async function api(url) {
  let res
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20000) })
  } catch (err) {
    fail(`could not reach GitHub for Garnet releases: ${err.message}`)
  }
  if (!res.ok) fail(`GitHub answered ${res.status} for the Garnet release list`)
  return res.json()
}

/** The Windows x64 self-contained zip on a release, or null. */
export function windowsZipFrom(release) {
  const assets = release?.assets ?? []
  const win = assets.filter((a) => /win-?x64/i.test(a.name) && /\.zip$/i.test(a.name))
  // "readytorun" and "self-contained" builds carry their own runtime; a framework-dependent zip
  // would need .NET installed, which defeats the point.
  const hit = win.find((a) => /readytorun|self-?contained/i.test(a.name)) ?? win[0]
  if (!hit) return null
  const digest = typeof hit.digest === 'string' && hit.digest.startsWith('sha256:') ? hit.digest.slice(7) : null
  return { name: hit.name, url: hit.browser_download_url, sha256: digest, size: Number(hit.size) || 0 }
}

export function releasesFrom(list, { includeUnstable = false } = {}) {
  const out = []
  for (const r of list ?? []) {
    if (r.draft) continue
    if (!includeUnstable && r.prerelease) continue
    if (!windowsZipFrom(r)) continue
    out.push({
      version: String(r.tag_name ?? r.name ?? '').replace(/^v/, ''),
      status: r.prerelease ? 'Pre-release' : 'Stable',
      support: null,
      date: r.published_at ? String(r.published_at).slice(0, 10) : null,
      tag: r.tag_name,
    })
  }
  return out
}

export async function versions(opts = {}) {
  return releasesFrom(await api(RELEASES), opts)
}

export function engineDir(version) {
  return path.join(ENGINES_DIR, `garnet-${version}`)
}

/**
 * The server binary, wherever the zip put it: the root, bin/, or one folder down. A .mjs is a
 * test standing in for it.
 */
export function binary(dir, role = 'server') {
  if (role !== 'server') return null
  const names = ['GarnetServer.exe', 'GarnetServer', 'GarnetServer.mjs']
  const places = [dir, path.join(dir, 'bin')]
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) places.push(path.join(dir, e.name))
  } catch {
    return null
  }
  for (const p of places) {
    for (const n of names) {
      const f = path.join(p, n)
      if (fs.existsSync(f)) return { path: f, script: n.endsWith('.mjs') }
    }
  }
  return null
}

export function hasEngine(version) {
  return Boolean(binary(engineDir(version)))
}

function runnable(bin, args, env = process.env) {
  if (bin.script) return { cmd: process.execPath, args: [bin.path, ...args], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
  return { cmd: bin.path, args, env }
}

export async function fetchEngine(version, { onProgress = null, force = false } = {}) {
  const dir = engineDir(version)
  if (hasEngine(version) && !force) {
    onProgress?.({ cached: true, message: `Garnet ${version} is already here` })
    return { version, dir, cached: true }
  }
  if (process.platform !== 'win32') {
    fail(`Garnet ${version} is not in the engine store, and only the Windows build is fetched from here.\n` +
      `  Put a GarnetServer in ${dir} to run one on this platform.`)
  }
  const list = await api(RELEASES)
  const release = list.find((r) => String(r.tag_name).replace(/^v/, '') === String(version).replace(/^v/, ''))
  if (!release) fail(`Garnet has no release ${version}. See: mcctl db versions --engine garnet`)
  const zip = windowsZipFrom(release)
  if (!zip) fail(`Garnet ${version} publishes no Windows zip.`)

  fs.mkdirSync(ENGINES_DIR, { recursive: true })
  const archive = path.join(ENGINES_DIR, zip.name)
  const tmp = `${archive}.part`
  onProgress?.({ message: `Downloading Garnet ${version}`, received: 0, total: zip.size })
  let res
  try {
    res = await fetch(zip.url, { headers: { 'User-Agent': UA } })
  } catch (err) {
    fail(`download failed for Garnet ${version}: ${err.message}`)
  }
  if (!res.ok || !res.body) fail(`download failed (${res.status}) for ${zip.url}`)
  const hash = crypto.createHash('sha256')
  const source = Readable.fromWeb(res.body)
  let received = 0
  const total = Number(res.headers.get('content-length')) || zip.size || 0
  source.on('data', (chunk) => {
    hash.update(chunk)
    received += chunk.length
    onProgress?.({ message: `Downloading Garnet ${version}`, received, total })
  })
  await pipeline(source, fs.createWriteStream(tmp))
  const got = hash.digest('hex')
  if (zip.sha256 && got !== zip.sha256) {
    fs.rmSync(tmp, { force: true })
    fail(`checksum mismatch for ${zip.name}\n  expected ${zip.sha256}\n  got      ${got}`)
  }
  fs.renameSync(tmp, archive)
  onProgress?.({ message: `Unpacking Garnet ${version}`, received: total, total })
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  try {
    await runTar(['-xf', archive, '-C', dir], ENGINES_DIR)
  } finally {
    fs.rmSync(archive, { force: true })
  }
  if (!binary(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
    fail(`${zip.name} unpacked, but holds no GarnetServer.`)
  }
  return { version, dir, cached: false, sizeHuman: humanBytes(total) }
}

export function dataDir(inst) {
  return path.join(inst.dir, 'data')
}

/** Nothing to initialise but the folder: Garnet makes its checkpoint files on first save. */
export function initData(inst) {
  fs.mkdirSync(dataDir(inst), { recursive: true })
  return { initialised: true }
}

/**
 * Loopback, password auth, checkpoints and an append-only log in the data folder, recovered
 * on start. The password is on the command line, which is readable by other processes on this
 * machine; Garnet takes it no other way, and this is one person's PC. Stop is SAVE then
 * SHUTDOWN over the protocol itself.
 */
export function launchSpec(inst) {
  const dir = engineDir(inst.version)
  const server = binary(dir)
  if (!server) fail(`Garnet ${inst.version} is not in the engine store (${dir}). Add the database again to fetch it.`)
  const run = runnable(server, [
    '--port', String(inst.port),
    '--bind', '127.0.0.1',
    '--auth', 'Password',
    '--password', inst.root?.password ?? '',
    '--checkpointdir', dataDir(inst),
    '--recover',
    '--aof',
  ])
  return {
    cmd: run.cmd,
    args: run.args,
    env: run.env,
    cwd: inst.dir,
    ready: READY_RE,
    failed: FAILED_RE,
    stop: { resp: { host: '127.0.0.1', port: inst.port, password: inst.root?.password ?? '', commands: [['SAVE'], ['SHUTDOWN']] } },
  }
}

// ---- the engine interface ----------------------------------------------------------------------

export function hostOf(inst) {
  return inst.host ?? '127.0.0.1'
}

/** Is it answering? PING with the password. */
export async function probe(inst) {
  return respPing(hostOf(inst), inst.port, { password: inst.root?.password || null })
}

/** One key space, one password: an attachment is a record of who uses it, not a new user. */
export function newRecord(serverName, inst) {
  return { database: null, user: null, password: inst.root?.password ?? '', keyPrefix: `${serverName}:`, createdAt: new Date().toISOString() }
}

export function provision() {
  return { provisioned: false }
}

export function deprovision() {
  return { deprovisioned: false }
}

export function credentialsFor(inst, record) {
  const host = hostOf(inst)
  const pw = record.password ?? inst.root?.password ?? ''
  return {
    url: `redis://${pw ? ':' + encodeURIComponent(pw) + '@' : ''}${host}:${inst.port}`,
    keyPrefix: record.keyPrefix ?? null,
    note: 'Redis has no per-server databases or users: every server attached here shares this password and key space. Plugins prefix their keys; LuckPerms and most others do it for you.',
  }
}

export const canDump = false
