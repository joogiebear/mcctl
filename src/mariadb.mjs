import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { ENGINES_DIR } from './paths.mjs'
import { runTar } from './backup.mjs'
import { fail, humanBytes } from './util.mjs'
import { MARIADB_READY_RE, MARIADB_FAILED_RE } from './ready.mjs'

/**
 * MariaDB as an engine SpawnLoft runs: where to get it, how to lay a database out on it, how to
 * start, stop and talk to one.
 *
 * <p>Nothing is installed. MariaDB publishes a portable zip for Windows - `mariadbd`, the init
 * tool, the admin tool, the client and the dump tool, all under bin/ - and a REST API that lists
 * releases with checksums. That is the Paper download pattern exactly: resolve a version, fetch
 * the file, verify it, keep it in a store shared by every database on that version. Windows's own
 * tar unpacks zips, so there is nothing to add for that either.
 *
 * <p>The engine store is `<data>/engines/mariadb-<version>/`. A test drops scripts named like the
 * real binaries into such a folder, and everything here runs them with this Node instead - the
 * same trick the lifecycle tests play with a fake JVM.
 */

const API = 'https://downloads.mariadb.org/rest-api/mariadb/'
const UA = 'SpawnLoft (github.com/joogiebear/spawnloft)'

export const ENGINE = 'mariadb'
export const LABEL = 'MariaDB'
export const DEFAULT_PORT = 3306

async function api(url) {
  let res
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) })
  } catch (err) {
    fail(`could not reach the MariaDB download API: ${err.message}`)
  }
  if (!res.ok) fail(`the MariaDB download API returned ${res.status} for ${url}`)
  return res.json()
}

/** Numeric-aware sort key for "11.4.5" style versions, newest first. */
function byVersionDesc(a, b) {
  const pa = a.split(/[.-]/).map((x) => (Number.isNaN(Number(x)) ? x : Number(x)))
  const pb = b.split(/[.-]/).map((x) => (Number.isNaN(Number(x)) ? x : Number(x)))
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return y - x
    return String(y).localeCompare(String(x))
  }
  return 0
}

/**
 * Releases the API lists, newest first. Stable ones unless asked otherwise: a release candidate
 * is not what anyone means by "a database" unless they say so.
 */
export function releasesFrom(payload, { includeUnstable = false } = {}) {
  const releases = payload?.releases ?? {}
  const out = []
  for (const [id, r] of Object.entries(releases)) {
    const status = String(r?.release_status ?? '')
    if (!includeUnstable && !/stable/i.test(status)) continue
    out.push({
      version: r?.release_id ?? id,
      status,
      support: r?.release_support_type ?? null,
      date: r?.date_of_release ?? null,
    })
  }
  return out.sort((a, b) => byVersionDesc(a.version, b.version))
}

export async function versions(opts = {}) {
  return releasesFrom(await api(API), opts)
}

/** The Windows x64 zip in a release's file list, or null when the release has none. */
export function windowsZipFrom(payload) {
  const files = payload?.files ?? []
  const hit = files.find((f) =>
    /windows/i.test(String(f?.os ?? '')) &&
    /zip/i.test(String(f?.package_type ?? '')) &&
    /x86_64|amd64|x64/i.test(String(f?.cpu ?? '')))
  if (!hit) return null
  return {
    name: hit.file_name,
    url: hit.file_download_url,
    sha256: hit.checksum?.sha256sum ?? null,
    size: Number(hit.size) || 0,
  }
}

export async function fileFor(version) {
  const zip = windowsZipFrom(await api(`${API}${encodeURIComponent(version)}/`))
  if (!zip) fail(`MariaDB ${version} publishes no Windows zip, so it cannot be run from here.`)
  return zip
}

export function engineDir(version) {
  return path.join(ENGINES_DIR, `mariadb-${version}`)
}

// The names a binary has had. MariaDB renamed them in 10.4+ and ships the old names alongside
// for a while; older zips have only the mysql names. A .mjs is a test standing in for the binary.
const NAMES = {
  server: ['mariadbd', 'mysqld'],
  init: ['mariadb-install-db', 'mysql_install_db'],
  admin: ['mariadb-admin', 'mysqladmin'],
  client: ['mariadb', 'mysql'],
  dump: ['mariadb-dump', 'mysqldump'],
}

export function binary(dir, role) {
  for (const name of NAMES[role]) {
    for (const ext of ['.exe', '', '.mjs']) {
      const p = path.join(dir, 'bin', name + ext)
      if (fs.existsSync(p)) return { path: p, script: ext === '.mjs' }
    }
  }
  return null
}

export function hasEngine(version) {
  return Boolean(binary(engineDir(version), 'server'))
}

/** How to run a binary: itself, or - a script standing in for it - this Node told to be Node. */
function runnable(bin, args, env = process.env) {
  if (bin.script) return { cmd: process.execPath, args: [bin.path, ...args], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
  return { cmd: bin.path, args, env }
}

/**
 * Download and unpack one engine version into the store.
 *
 * <p>The zip is hashed as it arrives and renamed into place only if the hash matches, so a
 * truncated download is a .part file and never a half-engine. Unpacked with --strip-components,
 * so the store holds bin/ directly rather than the zip's own top folder.
 */
export async function fetchEngine(version, { onProgress = null, force = false } = {}) {
  const dir = engineDir(version)
  if (hasEngine(version) && !force) {
    onProgress?.({ cached: true, message: `MariaDB ${version} is already here` })
    return { version, dir, cached: true }
  }
  if (process.platform !== 'win32') {
    fail(`MariaDB ${version} is not in the engine store, and only the Windows build is fetched from here.\n` +
      `  Put a MariaDB with bin/mariadbd in ${dir} to run one on this platform.`)
  }
  const zip = await fileFor(version)
  fs.mkdirSync(ENGINES_DIR, { recursive: true })
  const archive = path.join(ENGINES_DIR, zip.name)
  const tmp = `${archive}.part`

  onProgress?.({ message: `Downloading MariaDB ${version}`, received: 0, total: zip.size })
  let res
  try {
    res = await fetch(zip.url, { headers: { 'User-Agent': UA } })
  } catch (err) {
    fail(`download failed for MariaDB ${version}: ${err.message}`)
  }
  if (!res.ok || !res.body) fail(`download failed (${res.status}) for ${zip.url}`)
  const hash = crypto.createHash('sha256')
  const source = Readable.fromWeb(res.body)
  let received = 0
  const total = Number(res.headers.get('content-length')) || zip.size || 0
  source.on('data', (chunk) => {
    hash.update(chunk)
    received += chunk.length
    onProgress?.({ message: `Downloading MariaDB ${version}`, received, total })
  })
  await pipeline(source, fs.createWriteStream(tmp))
  const got = hash.digest('hex')
  if (zip.sha256 && got !== zip.sha256) {
    fs.rmSync(tmp, { force: true })
    fail(`checksum mismatch for ${zip.name}\n  expected ${zip.sha256}\n  got      ${got}`)
  }
  fs.renameSync(tmp, archive)

  onProgress?.({ message: `Unpacking MariaDB ${version}`, received: total, total })
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  try {
    await runTar(['-xf', archive, '--strip-components=1', '-C', dir], ENGINES_DIR)
  } finally {
    fs.rmSync(archive, { force: true })
  }
  if (!binary(dir, 'server')) {
    fs.rmSync(dir, { recursive: true, force: true })
    fail(`${zip.name} unpacked, but holds no MariaDB server binary under bin/.`)
  }
  return { version, dir, cached: false, sizeHuman: humanBytes(total) }
}

// ---- one database on the engine ---------------------------------------------------------------

export function dataDir(inst) {
  return path.join(inst.dir, 'data')
}

export function iniFile(inst) {
  return path.join(inst.dir, 'my.ini')
}

/**
 * The server's configuration, written by us rather than left to the init tool.
 *
 * <p>Loopback only, by the same reasoning as the panel: nothing this program runs listens on an
 * interface the router can see. skip-name-resolve keeps every grant keyed by address, which is
 * what the attach step writes. utf8mb4 because plugins store player names and chat.
 */
export function iniFor(inst) {
  const dd = dataDir(inst).replace(/\\/g, '/')
  return [
    '# Written by SpawnLoft. Edit if you like; the port and bind-address are what the panel shows.',
    '[mysqld]',
    `datadir=${dd}`,
    `port=${inst.port}`,
    'bind-address=127.0.0.1',
    'skip-name-resolve',
    'character-set-server=utf8mb4',
    'collation-server=utf8mb4_unicode_ci',
    'max_connections=100',
    '',
    '[client]',
    `port=${inst.port}`,
    'default-character-set=utf8mb4',
    '',
  ].join('\n')
}

/**
 * Lay the database out: system tables with the root password, and our my.ini beside them.
 *
 * <p>Done once. A data folder that already holds system tables is left alone, so re-running is
 * safe and a failed later step never re-initialises a database that has data in it.
 */
export function initData(inst) {
  const dir = engineDir(inst.version)
  const init = binary(dir, 'init')
  if (!init) fail(`MariaDB ${inst.version} has no init tool under ${dir}`)
  const dd = dataDir(inst)
  fs.mkdirSync(inst.dir, { recursive: true })
  fs.writeFileSync(iniFile(inst), iniFor(inst))
  if (fs.existsSync(path.join(dd, 'mysql'))) return { initialised: false }

  const { cmd, args, env } = runnable(init, [`--datadir=${dd}`, `--password=${inst.root.password}`, `--port=${inst.port}`])
  const res = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 180000, env })
  if (res.error) fail(`could not run the MariaDB init tool: ${res.error.message}`)
  if (res.status !== 0) {
    fail(`MariaDB could not set up its data folder (exit ${res.status}):\n${(res.stderr || res.stdout || '').trim()}`)
  }
  return { initialised: true }
}

/**
 * What the daemon spawns, what it watches for, and how it asks the process to stop.
 *
 * <p>--console puts the log on stderr, which the daemon captures like stdout. Stop is the admin
 * tool over TCP rather than stdin, because a database takes no console input; the password rides
 * in the environment the way the client tools expect, and never on a command line.
 */
export function launchSpec(inst) {
  const dir = engineDir(inst.version)
  const server = binary(dir, 'server')
  if (!server) fail(`MariaDB ${inst.version} is not in the engine store (${dir}). Add the database again to fetch it.`)
  const admin = binary(dir, 'admin')
  const run = runnable(server, [`--defaults-file=${iniFile(inst)}`, '--console'])
  const stop = admin
    ? runnable(admin, ['--protocol=TCP', '--host=127.0.0.1', `--port=${inst.port}`, '--user=root', 'shutdown'],
      { ...process.env, MYSQL_PWD: inst.root?.password ?? '' })
    : null
  return {
    cmd: run.cmd,
    args: run.args,
    env: run.env,
    cwd: inst.dir,
    ready: MARIADB_READY_RE,
    failed: MARIADB_FAILED_RE,
    stop,
  }
}

// ---- talking to a running database -----------------------------------------------------------

export function quoteIdent(name) {
  return '`' + String(name).replace(/`/g, '``') + '`'
}

export function quoteStr(s) {
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'"
}

/** Run statements as root over TCP. Returns stdout; a refusal names the reason. */
export function sql(inst, statements) {
  const dir = engineDir(inst.version)
  const client = binary(dir, 'client')
  if (!client) fail(`MariaDB ${inst.version} has no client tool under ${dir}`)
  const { cmd, args, env } = runnable(client,
    ['--protocol=TCP', '--host=127.0.0.1', `--port=${inst.port}`, '--user=root', '--batch', '--skip-column-names', '--execute', statements],
    { ...process.env, MYSQL_PWD: inst.root?.password ?? '' })
  const res = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 60000, env })
  if (res.error) fail(`could not run the MariaDB client: ${res.error.message}`)
  if (res.status !== 0) fail(`MariaDB refused: ${(res.stderr || res.stdout || `exit ${res.status}`).trim()}`)
  return res.stdout ?? ''
}

/**
 * The statements that give a server its own database and user, and take them away again.
 *
 * <p>Two hosts because skip-name-resolve keys TCP connections by address: 'localhost' matches a
 * socket or a named pipe, '127.0.0.1' matches what a plugin actually opens. Granted on that one
 * database and nothing else. IF NOT EXISTS plus ALTER, so attaching twice repairs rather than
 * refuses.
 */
export function attachSql({ database, user, password }) {
  const db = quoteIdent(database)
  const hosts = ['localhost', '127.0.0.1'].map((h) => `${quoteStr(user)}@${quoteStr(h)}`)
  return [
    `CREATE DATABASE IF NOT EXISTS ${db} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
    ...hosts.map((u) => `CREATE USER IF NOT EXISTS ${u} IDENTIFIED BY ${quoteStr(password)};`),
    ...hosts.map((u) => `ALTER USER ${u} IDENTIFIED BY ${quoteStr(password)};`),
    `GRANT ALL PRIVILEGES ON ${db}.* TO ${hosts.join(', ')};`,
    'FLUSH PRIVILEGES;',
  ].join('\n')
}

export function detachSql({ database, user, drop = false }) {
  const hosts = ['localhost', '127.0.0.1'].map((h) => `${quoteStr(user)}@${quoteStr(h)}`)
  const lines = [`DROP USER IF EXISTS ${hosts.join(', ')};`]
  if (drop) lines.push(`DROP DATABASE IF EXISTS ${quoteIdent(database)};`)
  lines.push('FLUSH PRIVILEGES;')
  return lines.join('\n')
}
