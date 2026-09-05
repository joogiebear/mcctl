import fs from 'node:fs'
import path from 'node:path'

import { setYamlValues } from './yamlpath.mjs'
import { listPlugins } from './plugins.mjs'
import { fail } from './util.mjs'

/**
 * Writing a database's connection details into the plugins that want them.
 *
 * <p>Each helper knows one plugin: where its config lives, which keys carry the connection, and
 * what the plugin calls the storage mode. The keys are set in place with the comment-preserving
 * editor, so the config the plugin wrote stays the config the person can read - only the values
 * change. Only ever on a click, and only when the file is there: a plugin writes its config on
 * its first start, and there is nothing to edit before that.
 */
export const HELPERS = [
  {
    id: 'luckperms',
    label: 'LuckPerms',
    plugin: /^luckperms$/i,
    file: 'plugins/LuckPerms/config.yml',
    edits: (c) => [
      { path: ['storage-method'], value: 'mariadb' },
      { path: ['data', 'address'], value: `${c.host}:${c.port}` },
      { path: ['data', 'database'], value: c.database },
      { path: ['data', 'username'], value: c.user },
      { path: ['data', 'password'], value: c.password },
    ],
    note: 'storage-method becomes mariadb. Existing H2 data is not migrated; LuckPerms has /lp migration for that.',
  },
  {
    id: 'coreprotect',
    label: 'CoreProtect',
    plugin: /^coreprotect$/i,
    file: 'plugins/CoreProtect/config.yml',
    edits: (c) => [
      { path: ['use-mysql'], value: true },
      { path: ['mysql-host'], value: c.host },
      { path: ['mysql-port'], value: c.port },
      { path: ['mysql-database'], value: c.database },
      { path: ['mysql-username'], value: c.user },
      { path: ['mysql-password'], value: c.password },
    ],
    note: 'use-mysql becomes true. The SQLite log it kept until now stays in its folder, unread.',
  },
  {
    id: 'plan',
    label: 'Plan',
    plugin: /^plan$/i,
    file: 'plugins/Plan/config.yml',
    edits: (c) => [
      { path: ['Database', 'Type'], value: 'MySQL' },
      { path: ['Database', 'MySQL', 'Host'], value: c.host },
      { path: ['Database', 'MySQL', 'Port'], value: c.port },
      { path: ['Database', 'MySQL', 'User'], value: c.user },
      { path: ['Database', 'MySQL', 'Password'], value: c.password },
      { path: ['Database', 'MySQL', 'Database'], value: c.database },
    ],
    note: 'Database.Type becomes MySQL.',
  },
  {
    id: 'authme',
    label: 'AuthMe',
    plugin: /^authme$/i,
    file: 'plugins/AuthMe/config.yml',
    edits: (c) => [
      { path: ['DataSource', 'backend'], value: 'MYSQL' },
      { path: ['DataSource', 'mySQLHost'], value: c.host },
      { path: ['DataSource', 'mySQLPort'], value: String(c.port) },
      { path: ['DataSource', 'mySQLUsername'], value: c.user },
      { path: ['DataSource', 'mySQLPassword'], value: c.password },
      { path: ['DataSource', 'mySQLDatabase'], value: c.database },
    ],
    note: 'DataSource.backend becomes MYSQL.',
  },
]

export function helperById(id) {
  const h = HELPERS.find((x) => x.id === id)
  if (!h) fail(`no config helper for "${id}" - one of: ${HELPERS.map((x) => x.id).join(', ')}`)
  return h
}

/**
 * Which helpers apply to this server: the plugin is installed, and whether its config exists
 * yet. A plugin present without a config has not been started; the panel says so rather than
 * offering an Apply that would write a file the plugin then overwrites with its defaults.
 */
export function detectHelpers(inst) {
  let installed = []
  try {
    installed = listPlugins(inst).map((p) => p.name)
  } catch {
    /* no plugins folder yet */
  }
  return HELPERS.map((h) => {
    const file = path.join(inst.dir, h.file)
    return {
      id: h.id,
      label: h.label,
      file: h.file,
      pluginPresent: installed.some((n) => h.plugin.test(n)),
      configPresent: fs.existsSync(file),
      note: h.note,
    }
  })
}

/** Write one plugin's config. Returns what changed; the caller records it and says "restart". */
export function applyHelper(inst, id, creds) {
  const h = helperById(id)
  const file = path.join(inst.dir, h.file)
  if (!fs.existsSync(file)) {
    fail(`${h.label} has not written its config yet (${h.file}). Start the server once with the plugin installed, then apply.`)
  }
  const before = fs.readFileSync(file, 'utf8')
  const { text, written, inserted } = setYamlValues(before, h.edits(creds))
  if (text !== before) fs.writeFileSync(file, text)
  return { plugin: h.id, label: h.label, file: h.file, written, inserted, note: h.note }
}
