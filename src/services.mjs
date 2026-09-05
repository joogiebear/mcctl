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
