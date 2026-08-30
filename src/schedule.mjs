import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { DATA_ROOT, ROOT } from './paths.mjs'
import { readJson, writeJson, fail, validateName } from './util.mjs'

/**
 * Scheduled work, run by Windows.
 *
 * <p>Anything that has to happen while nobody is watching - a nightly backup, a restart at 5am -
 * needs something alive to run it, and mcctl has nothing that qualifies. The per-instance daemons
 * only exist while their server runs, so a stopped server would never be backed up. The desktop app
 * is a window someone closes. Writing a service of our own would mean owning startup, restart after
 * reboot, and the question of whether it is running at all.
 *
 * <p>Windows already has that daemon. Task Scheduler survives reboots, needs no privileges to use
 * for the current user, and records the exit code and next run time of everything it fires - which
 * is most of what a schedule screen has to show, without inventing a log.
 *
 * <p>Tasks run <b>interactive only</b>: while the person is logged in, including with the screen
 * locked, but not after a sign-out. Running regardless would mean storing a Windows password in the
 * task definition, which is not a thing to do quietly for a nightly backup. The panel shows the
 * mode rather than leaving it to be discovered at 3am.
 *
 * <p>The definitions live here, in mcctl's own file, and Task Scheduler holds only a trigger that
 * calls back into `mcctl task run <id>`. Two reasons: what a task DOES stays inside mcctl, where it
 * can be constrained to the handful of things a task is allowed to be; and editing a task's action
 * does not mean recreating a Windows task.
 */

const TASKS_FILE = () => path.join(DATA_ROOT, 'schedules.json')

/** One folder, so everything mcctl created can be removed in a single call at uninstall. */
export const TASK_FOLDER = 'mcctl'

const EMPTY = { version: 1, tasks: {} }

/**
 * What a scheduled task is allowed to do.
 *
 * <p>An allowlist rather than a command string, because a scheduler that runs arbitrary commands is
 * a way to execute anything as the logged-in user, written into a file that nothing guards.
 */
export const ACTIONS = {
  backup: { label: 'Take a backup', needsRunning: false },
  command: { label: 'Run a server command', needsRunning: true },
  restart: { label: 'Restart the server', needsRunning: false },
  stop: { label: 'Stop the server', needsRunning: true },
  start: { label: 'Start the server', needsRunning: false },
}

/**
 * What Task Scheduler's last-result codes mean.
 *
 * <p>They are HRESULTs, and the informational ones look exactly like failures: a task that has
 * simply never run reports 267011, which rendered as "exit 267011" reads like something broke at
 * 3am. Only 0 means it ran and succeeded; anything not listed here is a genuine exit code from
 * whatever the task invoked.
 */
const TASK_RESULT = {
  0: 'ok',
  267008: 'ready',
  267009: 'running',
  267010: 'disabled',
  267011: 'not run yet',
  267012: 'no more runs scheduled',
  267014: 'stopped by user',
  267045: 'queued',
  2147750687: 'already running, so this run was skipped',
  2147943645: 'not run - the machine was not logged in',
}

export function describeResult(code) {
  if (code == null) return 'unknown'
  return TASK_RESULT[code] ?? `failed (exit ${code})`
}

export function load() {
  const data = readJson(TASKS_FILE(), EMPTY)
  if (!data.tasks) data.tasks = {}
  return data
}

export function list() {
  const data = load()
  const live = queryWindows()
  return Object.entries(data.tasks)
    .map(([id, task]) => ({ id, ...task, windows: live.get(id) ?? null }))
    .sort((a, b) => a.instance.localeCompare(b.instance) || a.name.localeCompare(b.name))
}

/**
 * What Windows says about the tasks it is holding for us.
 *
 * <p>Read from the scheduler rather than remembered here, because the scheduler is the thing that
 * actually ran them. A task mcctl believes in that Windows has never heard of - someone deleted it
 * in Task Scheduler - shows as null rather than as working.
 */
function queryWindows() {
  const out = new Map()
  const ps = spawnSync(
    'powershell',
    ['-NoProfile', '-Command',
      `Get-ScheduledTask -TaskPath '\\${TASK_FOLDER}\\' -ErrorAction SilentlyContinue | ` +
      'ForEach-Object { $i = $_ | Get-ScheduledTaskInfo; ' +
      '[pscustomobject]@{ name=$_.TaskName; state=[string]$_.State; ' +
      'lastRun=[string]$i.LastRunTime; lastResult=$i.LastTaskResult; nextRun=[string]$i.NextRunTime } } | ' +
      // No -AsArray: that needs PowerShell 6+, and Windows ships 5.1. A single task therefore
      // comes back as an object rather than a one-element array, which is handled below.
      'ConvertTo-Json -Compress'],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 },
  )
  if (ps.status !== 0 || !ps.stdout.trim()) return out
  try {
    const parsed = JSON.parse(ps.stdout)
    for (const row of Array.isArray(parsed) ? parsed : [parsed]) out.set(row.name, row)
  } catch {
    /* nothing usable from the scheduler; every task reports as unknown */
  }
  return out
}

/**
 * The batch file a task actually runs.
 *
 * <p>A scheduled task starts with no environment, so ELECTRON_RUN_AS_NODE cannot be inherited - and
 * without it the desktop build's own executable would relaunch the application rather than run the
 * CLI. Putting it in a file also keeps a command line with three quoted paths out of the task
 * definition, where quoting it correctly is its own small nightmare.
 */
function writeShim(id) {
  const dir = path.join(DATA_ROOT, 'tasks')
  fs.mkdirSync(dir, { recursive: true })
  const shim = path.join(dir, `${id}.cmd`)
  const cli = path.join(ROOT, 'mcctl.mjs')
  const exe = process.execPath
  const viaElectron = Boolean(process.versions.electron)
  const runner = /[\\/]node(?:\.exe)?$/i.test(exe) ? 'node' : `"${exe}"`
  const lines = [
    '@echo off',
    viaElectron ? 'set ELECTRON_RUN_AS_NODE=1' : null,
    `${runner} "${cli}" task run ${id}`,
    'exit /b %errorlevel%',
  ].filter(Boolean)
  fs.writeFileSync(shim, lines.join('\r\n') + '\r\n')
  return shim
}

/** Translate a schedule into the schtasks flags that express it. */
function triggerArgs(schedule) {
  const at = schedule.at || '03:00'
  switch (schedule.kind) {
    case 'hourly':
      return ['/SC', 'HOURLY', '/MO', String(schedule.every || 1)]
    case 'daily':
      return ['/SC', 'DAILY', '/ST', at]
    case 'weekly':
      return ['/SC', 'WEEKLY', '/D', (schedule.day || 'SUN').toUpperCase(), '/ST', at]
    case 'minutes':
      return ['/SC', 'MINUTE', '/MO', String(schedule.every || 30)]
    case 'onlogon':
      return ['/SC', 'ONLOGON']
    default:
      fail(`unknown schedule kind "${schedule.kind}"`)
  }
}

function schtasks(args) {
  const res = spawnSync('schtasks', args, { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  if (res.error) fail(`could not run schtasks: ${res.error.message}`)
  if (res.status !== 0) fail(`schtasks failed: ${(res.stderr || res.stdout || '').trim()}`)
  return res.stdout
}

export function create({ instance, name, action, schedule, enabled = true }) {
  validateName(instance)
  if (!ACTIONS[action?.type]) fail(`unknown action "${action?.type}"`)
  if (action.type === 'command' && !String(action.line || '').trim()) fail('a command is required')

  const data = load()
  // Readable in Task Scheduler next to everything else on the machine, and unique without a clock.
  const base = `${instance}-${action.type}`
  let id = base
  for (let n = 2; data.tasks[id]; n++) id = `${base}-${n}`

  const shim = writeShim(id)
  schtasks(['/Create', '/TN', `${TASK_FOLDER}\\${id}`, '/TR', shim, ...triggerArgs(schedule), '/F'])
  if (!enabled) schtasks(['/Change', '/TN', `${TASK_FOLDER}\\${id}`, '/DISABLE'])

  data.tasks[id] = {
    instance,
    name: name || ACTIONS[action.type].label,
    action,
    schedule,
    enabled,
    createdAt: new Date().toISOString(),
  }
  writeJson(TASKS_FILE(), data)
  return { id, ...data.tasks[id] }
}

export function setEnabled(id, enabled) {
  const data = load()
  if (!Object.hasOwn(data.tasks, id)) fail(`no scheduled task "${id}"`)
  schtasks(['/Change', '/TN', `${TASK_FOLDER}\\${id}`, enabled ? '/ENABLE' : '/DISABLE'])
  data.tasks[id].enabled = Boolean(enabled)
  writeJson(TASKS_FILE(), data)
  return { id, ...data.tasks[id] }
}

export function remove(id) {
  const data = load()
  // Windows first: a definition without a trigger is inert, a trigger without a definition fires
  // into nothing and fails at 3am.
  try {
    schtasks(['/Delete', '/TN', `${TASK_FOLDER}\\${id}`, '/F'])
  } catch {
    /* already gone from the scheduler, which is the state we were heading for */
  }
  fs.rmSync(path.join(DATA_ROOT, 'tasks', `${id}.cmd`), { force: true })
  delete data.tasks[id]
  writeJson(TASKS_FILE(), data)
  return { id, removed: true }
}

/** Fire one now, without waiting for its trigger. */
export function runNow(id) {
  const data = load()
  if (!Object.hasOwn(data.tasks, id)) fail(`no scheduled task "${id}"`)
  schtasks(['/Run', '/TN', `${TASK_FOLDER}\\${id}`])
  return { id, started: true }
}

/**
 * Remove every task mcctl created.
 *
 * <p>For uninstall. Tasks left behind would keep firing at a program that is no longer there, which
 * is the kind of thing people find months later in Task Scheduler and cannot explain.
 */
export function removeAll() {
  const data = load()
  for (const id of Object.keys(data.tasks)) {
    try {
      remove(id)
    } catch {
      /* keep going; one stuck task should not strand the rest */
    }
  }
  return { removed: true }
}
