import fs from 'node:fs'
import path from 'node:path'

import { ROOT, RUN_DIR } from './paths.mjs'
import { listInstances } from './registry.mjs'
import { writeLaunchers } from './create.mjs'
import { rewriteShims } from './schedule.mjs'

/**
 * Re-point what was written for the last installation at this one.
 *
 * <p>Two kinds of file carry the installation's absolute path: the shim behind each scheduled task
 * and the start/console/stop launchers in each server folder. They are written once and read by
 * Windows or by a double-click, never by mcctl itself, so nothing notices when the path they name
 * stops existing. An ordinary update keeps the path. The rename from mcctl to SpawnLoft did not: the
 * executable changed name and the program folder with it.
 *
 * <p>So the panel records which executable and code folder it ran from, and when either differs
 * from the record - or there is no record, which is what an installation upgraded from before the
 * rename looks like - every shim and every launcher is rewritten. Cheap, idempotent, and it also
 * covers a program folder moved by hand.
 */
export function runtimeSignature() {
  return { exe: process.execPath, root: ROOT }
}

export function markerFile() {
  return path.join(RUN_DIR, 'runtime.json')
}

export function repairAfterMove({ marker = markerFile(), signature = runtimeSignature() } = {}) {
  let recorded = null
  try {
    recorded = JSON.parse(fs.readFileSync(marker, 'utf8'))
  } catch {
    // No record yet, or an unreadable one: treated as moved, which is the safe direction.
  }
  if (recorded && recorded.exe === signature.exe && recorded.root === signature.root) {
    return { moved: false, shims: 0, launchers: 0 }
  }

  const shims = rewriteShims()
  let launchers = 0
  for (const inst of listInstances()) {
    // A server whose folder is gone gets no launchers; that is its own problem, reported elsewhere.
    try {
      writeLaunchers(inst)
      launchers++
    } catch {}
  }

  fs.mkdirSync(path.dirname(marker), { recursive: true })
  fs.writeFileSync(marker, JSON.stringify(signature, null, 2) + '\n')
  return { moved: true, shims, launchers }
}
