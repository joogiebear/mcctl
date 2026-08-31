import path from 'node:path'
import fs from 'node:fs'

import { CODE_ROOT, resolveRoots } from './settings.mjs'

/**
 * Every location mcctl uses, resolved once at startup from settings.
 *
 * <p>Resolved at import rather than per call: these are read on nearly every operation, and a data
 * root that could change underneath a running process would mean an instance created in one
 * directory and looked for in another. Changing locations takes effect on restart, which is also
 * the only point at which moving servers between drives could be safe.
 */
const roots = resolveRoots()

/**
 * Where the code lives — NOT where data lives.
 *
 * <p>The two were the same thing until data locations became configurable, and they are still the
 * same on an existing checkout. Anything that needs to invoke mcctl itself (the generated .bat
 * launchers) wants this; anything that reads or writes user data wants the roots below.
 */
export const ROOT = CODE_ROOT

export const DATA_ROOT = roots.dataRoot
export const REGISTRY_FILE = roots.registryFile
export const INSTANCES_DIR = roots.instancesDir
export const TEMPLATES_DIR = roots.templatesDir
export const JARS_DIR = roots.jarsDir
export const BACKUPS_DIR = roots.backupsDir
export const RUN_DIR = roots.runDir

/** The resolved layout, for `mcctl config` and the panel's settings screen. */
export const LAYOUT = roots

/** Per-instance runtime scratch: pid/state file, captured console. */
export function runDir(name) {
  return path.join(RUN_DIR, name)
}

export function stateFile(name) {
  return path.join(runDir(name), 'state.json')
}

export function consoleLog(name) {
  return path.join(runDir(name), 'console.log')
}

export function daemonLog(name) {
  return path.join(runDir(name), 'daemon.log')
}

/**
 * Control channel the daemon listens on for stdin injection and shutdown.
 * Named pipe on Windows, unix socket elsewhere.
 */
export function controlPath(name) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\mcctl-${name}`
  return path.join(runDir(name), 'control.sock')
}

export function ensureDirs() {
  for (const d of [INSTANCES_DIR, TEMPLATES_DIR, JARS_DIR, BACKUPS_DIR, RUN_DIR]) {
    fs.mkdirSync(d, { recursive: true })
  }
}
