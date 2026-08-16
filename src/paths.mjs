import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const REGISTRY_FILE = path.join(ROOT, 'instances.json')
export const INSTANCES_DIR = path.join(ROOT, 'instances')
export const TEMPLATES_DIR = path.join(ROOT, 'templates')
export const JARS_DIR = path.join(ROOT, 'jars')
export const BACKUPS_DIR = path.join(ROOT, 'backups')
export const RUN_DIR = path.join(ROOT, 'run')

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
