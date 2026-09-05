import fs from 'node:fs'
import path from 'node:path'

import { SERVICES_DIR } from './paths.mjs'
import {
  getInstance, putInstance, updateInstance, removeInstance, hasInstance, listServices, isDatabase,
  usedPorts, assertPortUsable,
} from './registry.mjs'
import * as mariadb from './mariadb.mjs'
import { readState, clearState } from './control.mjs'
import { fail, findFreePort, randomPassword, validateName, cleanLabel } from './util.mjs'
import { readState as stateOf } from './control.mjs'

/**
 * Databases: registered like servers, run by the same daemon, attached to servers with their
 * own credentials.
 *
 * <p>One engine module for now. The shape here - engine, version, port, a root password, a map of
 * attachments keyed by server - is what a second engine would fill in the same way.
 */

export const ENGINES = {
  [mariadb.ENGINE]: { label: mariadb.LABEL, defaultPort: mariadb.DEFAULT_PORT, module: mariadb },
}

function engineOf(inst) {
  const engine = ENGINES[inst.engine]
  if (!engine) fail(`"${inst.name}" runs an engine this build does not know: ${inst.engine}`)
  return engine.module
}

export function getDatabase(name) {
  const inst = getInstance(name)
  if (!isDatabase(inst)) fail(`"${name}" is a server, not a database`)
  return inst
}

export function assertServer(name) {
  const inst = getInstance(name)
  if (isDatabase(inst)) fail(`"${name}" is a database, not a server`)
  return inst
}

/** Every database a server is attached to, without the passwords. */
export function serverAttachments(serverName) {
  const out = []
  for (const db of listServices()) {
    const a = db.attachments?.[serverName]
    if (!a) continue
    out.push({
      service: db.name,
      label: db.label ?? null,
      engine: db.engine,
      version: db.version,
      host: '127.0.0.1',
      port: db.port,
      database: a.database,
      user: a.user,
      createdAt: a.createdAt ?? null,
    })
  }
  return out
}

/** The engine's version list, for a picker. */
export async function versionsFor(engine = mariadb.ENGINE) {
  if (!ENGINES[engine]) fail(`unknown database engine "${engine}"`)
  return ENGINES[engine].module.versions()
}

/**
 * Make a database: fetch its engine if the store lacks it, lay out its folder, register it.
 *
 * <p>Registered last, so a download that fails or an init that refuses leaves nothing behind but
 * the engine, which is worth keeping.
 */
export async function createDatabase(name, { engine = mariadb.ENGINE, version, port = null, label = null, onProgress = null } = {}) {
  validateName(name)
  if (hasInstance(name)) fail(`"${name}" already exists - servers and databases share one set of names`)
  if (!ENGINES[engine]) fail(`unknown database engine "${engine}"`)
  if (!version) fail('a version is required - see: mcctl db versions')
  const mod = ENGINES[engine].module

  const chosenPort = port != null
    ? assertPortUsable(name, Number(port))
    : await findFreePort(ENGINES[engine].defaultPort, usedPorts())

  await mod.fetchEngine(String(version), { onProgress })

  const dir = path.join(SERVICES_DIR, name)
  const inst = {
    kind: 'database',
    engine,
    version: String(version),
    dir,
    port: chosenPort,
    root: { password: randomPassword(24) },
    autoRestart: true,
    attachments: {},
    createdAt: new Date().toISOString(),
  }
  const clean = cleanLabel(label)
  if (clean && clean !== name) inst.label = clean

  onProgress?.({ message: `Setting up ${ENGINES[engine].label} ${version} on port ${chosenPort}` })
  try {
    mod.initData({ name, ...inst })
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw err
  }
  putInstance(name, inst)
  return { name, ...inst }
}

/** Remove a stopped database from the registry and, if asked, from disk. */
export function removeDatabase(name, { purge = false } = {}) {
  const inst = getDatabase(name)
  const { status } = readState(name)
  if (status === 'running' || status === 'stopping') fail(`"${name}" is running - stop it before deleting it`)
  const attached = Object.keys(inst.attachments ?? {})
  if (purge) {
    try {
      fs.rmSync(inst.dir, { recursive: true, force: true })
    } catch (err) {
      fail(`could not delete ${inst.dir}: ${err.message}\n  "${name}" is still registered.`)
    }
  }
  removeInstance(name)
  clearState(name)
  return { name, purged: purge, detached: attached }
}

/**
 * Give a server its own database and user on a running database, and remember it.
 *
 * <p>Idempotent: attaching again re-asserts the same credentials rather than minting new ones,
 * so a plugin config written from the first attach keeps working.
 */
export function attach(dbName, serverName) {
  const db = getDatabase(dbName)
  assertServer(serverName)
  if (readState(dbName).status !== 'running') fail(`"${dbName}" is not running - start it first, then attach`)
  const existing = db.attachments?.[serverName]
  const record = existing ?? {
    database: serverName,
    user: serverName,
    password: randomPassword(24),
    createdAt: new Date().toISOString(),
  }
  engineOf(db).sql(db, engineOf(db).attachSql(record))
  updateInstance(dbName, { attachments: { ...(db.attachments ?? {}), [serverName]: record } })
  return credentials(dbName, serverName)
}

/** Take the user away; the data stays unless `drop` says otherwise. */
export function detach(dbName, serverName, { drop = false } = {}) {
  const db = getDatabase(dbName)
  const record = db.attachments?.[serverName]
  if (!record) fail(`"${serverName}" is not attached to "${dbName}"`)
  if (readState(dbName).status === 'running') {
    engineOf(db).sql(db, engineOf(db).detachSql({ database: record.database, user: record.user, drop }))
  } else if (drop) {
    fail(`"${dbName}" is not running, so its data cannot be dropped - start it first, or detach without --drop`)
  }
  const rest = { ...(db.attachments ?? {}) }
  delete rest[serverName]
  updateInstance(dbName, { attachments: rest })
  return { service: dbName, server: serverName, dropped: drop, database: record.database }
}

/** Everything a plugin config needs, for one server on one database. */
export function credentials(dbName, serverName) {
  const db = getDatabase(dbName)
  const a = db.attachments?.[serverName]
  if (!a) fail(`"${serverName}" is not attached to "${dbName}" - attach it first`)
  return {
    service: dbName,
    server: serverName,
    engine: db.engine,
    host: '127.0.0.1',
    port: db.port,
    database: a.database,
    user: a.user,
    password: a.password,
    jdbc: `jdbc:mysql://127.0.0.1:${db.port}/${a.database}`,
  }
}

// ---- backups ------------------------------------------------------------------------------------

/** The file a dump takes inside a snapshot: databases/<service>__<database>.sql */
export function dumpFileFor(service, database) {
  return path.join('databases', `${service}__${database}.sql`)
}

/**
 * Dump every database a server is attached to, into `<dir>/databases/`.
 *
 * <p>Returns what was dumped, ready to go in a manifest, and what could not be: a database that
 * is not running has nothing to answer a dump with. That is reported, not thrown - the rest of
 * the snapshot is still worth taking, and the manifest says what it lacks.
 */
export async function dumpAttachments(serverName, dir) {
  const dumped = []
  const skipped = []
  for (const a of serverAttachments(serverName)) {
    const db = getDatabase(a.service)
    if (stateOf(db.name).status !== 'running') {
      skipped.push({ service: db.name, database: a.database, reason: 'the database is not running' })
      continue
    }
    const rel = dumpFileFor(db.name, a.database)
    try {
      const { bytes } = await engineOf(db).dump(db, a.database, path.join(dir, rel))
      dumped.push({ service: db.name, engine: db.engine, version: db.version, database: a.database, user: a.user, file: rel.replace(/\\/g, '/'), bytes })
    } catch (err) {
      skipped.push({ service: db.name, database: a.database, reason: err.message })
    }
  }
  return { dumped, skipped }
}

/**
 * Import the dumps a snapshot carried, each into the database it came from.
 *
 * <p>The dump names its own database, so the file goes in as root and lands where it was taken
 * from. A database that is gone from the registry, or not running, keeps its dump on disk and is
 * named as skipped: a restore must not lose a file it could not use.
 */
export async function importDumps(serverName, dumps, baseDir) {
  const imported = []
  const skipped = []
  for (const d of dumps) {
    const file = path.join(baseDir, d.file)
    if (!fs.existsSync(file)) {
      skipped.push({ ...d, reason: 'the dump is missing from the archive' })
      continue
    }
    if (!hasInstance(d.service) || !isDatabase(getInstance(d.service))) {
      skipped.push({ ...d, reason: `"${d.service}" is no longer here; the dump is left at ${file}` })
      continue
    }
    const db = getDatabase(d.service)
    if (stateOf(db.name).status !== 'running') {
      skipped.push({ ...d, reason: `"${d.service}" is not running; the dump is left at ${file}` })
      continue
    }
    try {
      await engineOf(db).importSql(db, file)
      imported.push(d)
    } catch (err) {
      skipped.push({ ...d, reason: `${err.message}; the dump is left at ${file}` })
    }
  }
  return { imported, skipped }
}
