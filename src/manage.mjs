import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { INSTANCES_DIR, runDir } from './paths.mjs'
import { getInstance, hasInstance, putInstance, removeInstance } from './registry.mjs'
import * as backup from './backup.mjs'
import * as supervisor from './supervisor.mjs'
import { UserError, validateName } from './util.mjs'

/**
 * Editing and destroying instances.
 *
 * <p>Everything here that destroys blocks takes a snapshot first, and none of it runs against a
 * live server. Both rules exist because the alternative was demonstrated: a plugin directory was
 * cleared by hand, a world went with it, and there was no snapshot to go back to.
 */

function assertStopped(name, verb) {
  if (supervisor.isRunning(name)) {
    throw new UserError(`"${name}" is running — stop it before ${verb}.`)
  }
}

/**
 * Rename an instance: registry key, directory, and runtime scratch.
 *
 * <p>The directory moves only when it sits where mcctl put it. An instance adopted from somewhere
 * else on disk keeps its path — moving a directory a person chose, because they renamed the entry
 * pointing at it, is not a rename, it is a surprise.
 */
export function rename(oldName, newName) {
  // The registry's rule, not a second one that happens to be looser. This used to accept names
  // like "_scratch" that putInstance then rejected - after removeInstance had already run and the
  // directory had already moved, which lost the instance from the registry entirely.
  try {
    validateName(newName)
  } catch {
    throw new UserError(
      `"${newName}" is not a usable name - start with a letter or digit, then letters, digits, ` +
        'dash or underscore, up to 32 characters.',
    )
  }
  const inst = getInstance(oldName)
  if (hasInstance(newName)) throw new UserError(`"${newName}" already exists`)
  assertStopped(oldName, 'renaming it')

  const { name: _drop, ...cfg } = inst
  const wasDefaultDir = path.resolve(inst.dir) === path.resolve(path.join(INSTANCES_DIR, oldName))
  if (wasDefaultDir) {
    const dest = path.join(INSTANCES_DIR, newName)
    fs.renameSync(inst.dir, dest)
    cfg.dir = dest
  }

  // The run directory holds the console log and the state file, both keyed by name. Moving it keeps
  // the history attached to the server it belongs to instead of stranding it under a dead name.
  const oldRun = runDir(oldName)
  if (fs.existsSync(oldRun)) {
    try {
      fs.renameSync(oldRun, runDir(newName))
    } catch {
      // A locked console log is not worth failing a rename over; a new one is created on start.
    }
  }

  removeInstance(oldName)
  putInstance(newName, cfg)
  return { name: newName, ...cfg, movedDir: wasDefaultDir }
}

/**
 * Return an instance to a fresh server, keeping its identity.
 *
 * <p>Deletes worlds and generated state; keeps the jar, the port, the memory and the name. What
 * counts as "generated" is listed explicitly rather than inferred, because a rebuild that guesses
 * wrong deletes something a person spent a week on.
 *
 * <p>`keepPlugins` is the difference between "reset the world" and "start over". Plugins are
 * usually the thing under development, so they survive by default.
 */
export async function rebuild(name, { keepPlugins = true, snapshot = true } = {}) {
  const inst = getInstance(name)
  assertStopped(name, 'rebuilding it')

  let snapshotFile = null
  if (snapshot) {
    // Before, not after. A rebuild is the moment someone most wants an undo and least expects to
    // need one.
    const res = await backup.createSnapshot(inst, { label: 'pre-rebuild' })
    snapshotFile = res?.file ?? res?.path ?? null
  }

  const wipe = ['world', 'world_nether', 'world_the_end', 'logs', 'cache', 'crash-reports',
    'usercache.json', 'usernamecache.json', 'banned-ips.json', 'banned-players.json', 'ops.json',
    'whitelist.json', 'session.lock']
  if (!keepPlugins) wipe.push('plugins')

  const removed = []
  for (const entry of wipe) {
    const target = path.join(inst.dir, entry)
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true })
      removed.push(entry)
    }
  }

  // Clear the captured console too, so the first line after a rebuild belongs to the rebuilt server.
  const log = path.join(runDir(name), 'console.log')
  if (fs.existsSync(log)) fs.rmSync(log, { force: true })

  return { name, removed, keptPlugins: keepPlugins, snapshot: snapshotFile }
}

/**
 * Delete an instance, optionally its files.
 *
 * <p>Always snapshots first when files are going. The registry entry is cheap to recreate; the
 * directory is not.
 */
export async function destroy(name, { purge = false, snapshot = true } = {}) {
  const inst = getInstance(name)
  assertStopped(name, 'deleting it')

  let snapshotFile = null
  if (purge && snapshot) {
    const res = await backup.createSnapshot(inst, { label: 'pre-delete' })
    snapshotFile = res?.file ?? res?.path ?? null
  }
  // Files first, registry second. The other order loses the instance from mcctl and leaves the
  // directory on disk when the delete fails - a locked world file is enough - and the person is
  // then holding a folder mcctl no longer knows about.
  if (purge) {
    try {
      fs.rmSync(inst.dir, { recursive: true, force: true })
    } catch (err) {
      throw new UserError(
        `could not delete ${inst.dir}: ${err.message}\n` +
          `  "${name}" is still registered. Close anything using that folder and try again.`,
      )
    }
  }
  removeInstance(name)
  return { name, purged: purge, snapshot: snapshotFile }
}

/** Open an instance's folder in the system file manager. */
export function reveal(name) {
  const inst = getInstance(name)
  const [cmd, args] =
    process.platform === 'win32' ? ['explorer.exe', [inst.dir]]
    : process.platform === 'darwin' ? ['open', [inst.dir]]
    : ['xdg-open', [inst.dir]]
  // explorer.exe exits non-zero even when it succeeds, so its result is deliberately not checked.
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
  } catch (err) {
    throw new UserError(`could not open ${inst.dir}: ${err.message}`)
  }
  return inst.dir
}
