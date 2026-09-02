import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

/** Errors of this class print as a clean one-line message instead of a stack. */
export class UserError extends Error {}

export function fail(msg) {
  throw new UserError(msg)
}

/**
 * The process table, remembered for two seconds.
 *
 * <p>A pid alone cannot say whether a process is the one a state file remembers: Windows hands
 * pids out again quickly, so a daemon that died hours ago could have its number worn by anything
 * by now, and a status read that only asks "is this pid alive" reports a dead server as running
 * forever - and `kill` would taskkill a stranger. The image name is the cheap second question.
 * Reading the whole table once and remembering it briefly costs one spawn per status poll rather
 * than one per pid per instance.
 */
let processTable = { at: 0, names: null }
const PROCESS_TABLE_MS = 2000

function readProcessTable() {
  const names = new Map()
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
      if (r.error || r.status !== 0) return null
      for (const line of r.stdout.split(/\r?\n/)) {
        const m = /^"([^"]*)","(\d+)"/.exec(line)
        if (m) names.set(Number(m[2]), m[1])
      }
    } else {
      const r = spawnSync('ps', ['-A', '-o', 'pid=,comm='], { encoding: 'utf8', timeout: 10000 })
      if (r.error || r.status !== 0) return null
      for (const line of r.stdout.split('\n')) {
        const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
        if (m) names.set(Number(m[1]), path.basename(m[2]))
      }
    }
  } catch {
    return null
  }
  return names
}

/** The executable name behind a pid, or null when the table cannot be read or the pid is not in it. */
export function processImage(pid) {
  if (!pid) return null
  if (!processTable.names || Date.now() - processTable.at > PROCESS_TABLE_MS) {
    processTable = { at: Date.now(), names: readProcessTable() }
  }
  return processTable.names?.get(pid) ?? null
}

/**
 * Whether a live pid is still the process it was recorded as.
 *
 * <p>Lenient in every direction that is not an outright contradiction: no expected name recorded
 * (a state file from before this existed), a table that could not be read, or a pid the table has
 * not caught up with yet all answer true, because the pid IS alive and that was the whole test
 * until now. Only "alive, and wearing a different name" answers false.
 */
export function sameProcess(pid, expectedImage) {
  if (!expectedImage) return true
  const actual = processImage(pid)
  if (!actual) return true
  const strip = (s) => String(s).toLowerCase().replace(/\.exe$/, '')
  return strip(actual) === strip(expectedImage)
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return fallback
    throw err
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
  fs.renameSync(tmp, file)
}

/** Signal 0 is a liveness probe on both Windows and POSIX. */
export function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, host)
  })
}

export async function findFreePort(start, taken = new Set()) {
  for (let port = start; port < start + 500; port++) {
    if (taken.has(port)) continue
    if (await isPortFree(port)) return port
  }
  fail(`no free port found in range ${start}-${start + 500}`)
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export function humanBytes(n) {
  if (n == null) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function humanDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return '-'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** Renders rows as an aligned text table. rows[0] is the header. */
export function table(rows) {
  if (!rows.length) return ''
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i] ?? '').length)))
  return rows
    .map((r) => r.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ').trimEnd())
    .join('\n')
}

export function dirSize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile()) {
        try {
          total += fs.statSync(full).size
        } catch {
          /* raced with a delete */
        }
      }
    }
  }
  return total
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i

export function validateName(name) {
  if (!NAME_RE.test(name)) {
    fail(`invalid instance name "${name}" - use letters, digits, dash, underscore (max 32 chars)`)
  }
  return name
}

/** Timestamp usable in filenames: 2026-08-16_142530 */
export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function randomPassword(len = 20) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  let out = ''
  for (const b of crypto.randomBytes(len)) out += alphabet[b % alphabet.length]
  return out
}
