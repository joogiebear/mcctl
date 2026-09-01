import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { BACKUPS_DIR } from './paths.mjs'
import { readProps, worldDirs } from './props.mjs'
import * as settings from './settings.mjs'
import { fail, stamp, humanBytes, writeJson, readJson, UserError } from './util.mjs'

/**
 * The mirror: a second location every snapshot is copied to as it is taken.
 *
 * <p>This closes the oldest risk in the tool: servers and their snapshots on one drive
 * means one disk failure takes both the thing and its way back. Read live from settings
 * rather than resolved at startup, so turning it on needs no restart - and a mirror that
 * cannot be written never fails the backup that just succeeded: the primary snapshot is
 * real, and the failure to copy it is reported, loudly, as exactly that.
 */
export function mirrorRoot() {
  const dir = settings.load().backupsMirrorDir
  return dir ? path.resolve(dir) : null
}

function mirrorCopy(name, file) {
  const root = mirrorRoot()
  if (!root) return { mirrored: null, mirrorError: null }
  try {
    const dir = path.join(root, name)
    fs.mkdirSync(dir, { recursive: true })
    const dest = path.join(dir, path.basename(file))
    fs.copyFileSync(file, dest)
    const manifest = file.replace(/\.tar\.gz$/, '.json')
    if (fs.existsSync(manifest)) fs.copyFileSync(manifest, dest.replace(/\.tar\.gz$/, '.json'))
    return { mirrored: dest, mirrorError: null }
  } catch (err) {
    return { mirrored: null, mirrorError: `the snapshot is safe, but mirroring it failed: ${err.message}` }
  }
}

/** Deletions keep the mirror in step - a retention limit that only thins one side is not one. */
function mirrorRemove(name, snapName) {
  const root = mirrorRoot()
  if (!root) return
  try {
    fs.rmSync(path.join(root, name, snapName), { force: true })
    fs.rmSync(path.join(root, name, snapName.replace(/\.tar\.gz$/, '.json')), { force: true })
  } catch {
    /* a mirror that cannot be tidied is rediscovered at the next copy */
  }
}

export const SCOPES = ['plugins', 'worlds', 'config', 'standard', 'full']

/**
 * Things that must never go into a snapshot.
 *
 * <p>`session.lock` is the one that matters. Minecraft holds it open exclusively for as long as the
 * server runs, and bsdtar does not skip a file it cannot read - it gives up on the whole archive,
 * exits 1, and leaves a zero-byte .tar.gz behind. So every snapshot of a running server produced
 * nothing while reporting success.
 *
 * <p>Excluding it costs nothing: it is a lock, it is regenerated on the next start, and restoring
 * a stale one would be actively wrong.
 */
export const EXCLUDE_ARGS = ['--exclude', 'session.lock']

const ROOT_CONFIG_FILES = [
  'server.properties',
  'bukkit.yml',
  'spigot.yml',
  'paper.yml',
  'paper-global.yml',
  'permissions.yml',
  'commands.yml',
  'help.yml',
  'ops.json',
  'whitelist.json',
  'banned-players.json',
  'banned-ips.json',
  'eula.txt',
]

/** Directories that are large, regenerable, and pointless to snapshot. */
const FULL_EXCLUDES = ['cache', 'libraries', 'versions', 'logs']

function backupDir(name) {
  const dir = path.join(BACKUPS_DIR, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function membersFor(inst, scope) {
  const props = readProps(path.join(inst.dir, 'server.properties'))
  const exists = (p) => fs.existsSync(path.join(inst.dir, p))

  // Mods are plugins' sibling on a Fabric server; the plugins scope covers both, because the
  // scope names the ROLE (the server's content) rather than the folder.
  const plugins = [...(exists('plugins') ? ['plugins'] : []), ...(exists('mods') ? ['mods'] : [])]
  const worlds = worldDirs(props).filter(exists)
  const config = [...ROOT_CONFIG_FILES.filter(exists), ...(exists('config') ? ['config'] : [])]

  switch (scope) {
    case 'plugins':
      return plugins
    case 'worlds':
      return worlds
    case 'config':
      return config
    case 'standard':
      return [...plugins, ...worlds, ...config]
    case 'full': {
      return fs
        .readdirSync(inst.dir)
        .filter((entry) => !FULL_EXCLUDES.includes(entry))
    }
    default:
      fail(`unknown backup scope "${scope}" - one of: ${SCOPES.join(', ')}`)
  }
}

/**
 * Which tar to run.
 *
 * <p>Windows ships bsdtar at System32\tar.exe, and this code has always assumed that is the one it
 * gets. It is not: `tar` resolves through PATH, and any machine with Git for Windows, MSYS or a
 * similar toolchain installed finds GNU tar first. GNU tar reads `C:\backups\x.tar.gz` as
 * host `C:` plus a path and tries to open a network connection to it, so every snapshot on such a
 * machine failed with "Cannot connect to C: resolve failed" - which meant rebuild and delete-with-
 * files were unusable, because both take a snapshot first and both correctly refuse to continue
 * without one.
 *
 * <p>Naming the binary rather than trusting PATH is the fix. bsdtar has no --force-local and does
 * not need one.
 */
function tarBinary() {
  if (process.platform !== 'win32') return 'tar'
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  return fs.existsSync(system32) ? system32 : 'tar'
}

export function runTar(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(tarBinary(), args, { cwd, windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (c) => {
      stderr += c.toString()
    })
    child.on('error', (err) =>
      reject(
        new UserError(
          err.code === 'ENOENT'
            ? 'tar was not found on PATH (Windows 10/11 ships tar.exe in System32)'
            : `tar failed: ${err.message}`,
        ),
      ),
    )
    child.on('exit', (code) => {
      // bsdtar exits 1 on warnings such as "file changed as we read it",
      // which is expected when snapshotting a running server.
      if (code === 0 || code === 1) resolve({ code, stderr })
      else reject(new UserError(`tar exited ${code}: ${stderr.trim() || 'unknown error'}`))
    })
  })
}

export async function createSnapshot(inst, { scope = 'standard', label = null, running = false, taskId = null } = {}) {
  const members = membersFor(inst, scope)
  if (!members.length) fail(`nothing to back up for scope "${scope}" in ${inst.dir}`)

  const slug = label ? `${label.replace(/[^a-z0-9_-]/gi, '-')}_` : ''
  const base = `${slug}${scope}_${stamp()}`
  const file = path.join(backupDir(inst.name), `${base}.tar.gz`)

  const { stderr } = await runTar(['-czf', file, ...EXCLUDE_ARGS, ...members], inst.dir)

  const size = fs.statSync(file).size
  // An empty archive is not a snapshot, and this one is load-bearing: rebuild and delete both take
  // one "first" and both are safe only if it exists. bsdtar reports a locked file as exit 1, which
  // is deliberately tolerated above because a hot snapshot legitimately skips things - so without
  // this check a failure that produced nothing at all would be recorded as a successful backup.
  if (size === 0) {
    fs.rmSync(file, { force: true })
    const said = stderr.trim().split(/\r?\n/)[0]
    fail(
      `snapshot of "${inst.name}" came out empty and has been discarded.` +
        (said ? `\n  tar said: ${said}` : ''),
    )
  }
  const manifest = {
    instance: inst.name,
    scope,
    label,
    // Which scheduled task produced this, so its retention limit governs its own snapshots
    // and nobody else's. Null for anything a person asked for directly.
    taskId,
    members,
    sourceDir: inst.dir,
    createdAt: new Date().toISOString(),
    size,
    serverWasRunning: running,
    // bsdtar emits an undescribed "tar: (null)" alongside exit 1 when it
    // skips a file the running server has locked. That carries no signal.
    warnings: stderr
      .trim()
      .split(/\r?\n/)
      .filter((l) => l.trim() && !/^tar:\s*\(null\)$/.test(l.trim()))
      .slice(0, 10),
  }
  writeJson(path.join(backupDir(inst.name), `${base}.json`), manifest)
  const { mirrored, mirrorError } = mirrorCopy(inst.name, file)
  return { file, size, members, manifest, mirrored, mirrorError }
}

export function listSnapshots(name) {
  const dir = backupDir(name)
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.tar.gz'))
    .map((f) => {
      const full = path.join(dir, f)
      const manifest = readJson(full.replace(/\.tar\.gz$/, '.json'), {})
      const st = fs.statSync(full)
      return {
        name: f,
        path: full,
        size: st.size,
        sizeHuman: humanBytes(st.size),
        mtime: st.mtime,
        scope: manifest.scope ?? '?',
        label: manifest.label ?? '',
        taskId: manifest.taskId ?? null,
        members: manifest.members ?? [],
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
}

export function resolveSnapshot(name, ref) {
  const all = listSnapshots(name)
  if (!all.length) fail(`no snapshots exist for "${name}"`)
  if (!ref || ref === 'latest') return all[0]
  const exact = all.find((s) => s.name === ref || s.name === `${ref}.tar.gz`)
  if (exact) return exact
  const partial = all.filter((s) => s.name.includes(ref))
  if (partial.length === 1) return partial[0]
  if (partial.length > 1) {
    fail(`snapshot "${ref}" is ambiguous:\n  ${partial.map((s) => s.name).join('\n  ')}`)
  }
  fail(`no snapshot matching "${ref}" for "${name}"`)
}

export async function restoreSnapshot(inst, snapshot) {
  if (!fs.existsSync(inst.dir)) fail(`instance directory is missing: ${inst.dir}`)
  await runTar(['-xzf', snapshot.path], inst.dir)
  return { restored: snapshot.name, into: inst.dir, members: snapshot.members }
}

/**
 * Read one archive back, end to end, and check it holds what it is supposed to.
 *
 * <p>A backup only actually exists at restore time - until then it is a file nothing has read
 * since the day it was written. Listing with -t decompresses every block, so the gzip checksums
 * are genuinely checked: this is not a stricter test than restoring, it IS restoring, minus the
 * writes. Any complaint here is the complaint a restore would make on the day it mattered.
 *
 * <p>The listing is then compared against the manifest's top-level members. That catches the
 * other way a snapshot lies: an archive that reads back perfectly but is missing a world,
 * because something held it locked on the night it was taken.
 *
 * <p>Unlike creation, a non-zero exit here is always a failure. runTar tolerates exit 1 because
 * bsdtar uses it for hot-snapshot warnings; on a read, exit 1 is how corruption reports itself.
 */
export async function verifyArchive(file, expectedMembers = []) {
  const problems = []
  let size = 0
  try {
    size = fs.statSync(file).size
  } catch {
    return { ok: false, size: 0, entries: 0, missing: [], problems: ['the archive file is missing'] }
  }
  if (size === 0) {
    return { ok: false, size, entries: 0, missing: [], problems: ['the archive is zero bytes'] }
  }

  let entries = 0
  const roots = new Set()
  const sawEntry = (line) => {
    const entry = line.trim().replace(/\\/g, '/')
    if (!entry) return
    entries++
    roots.add(entry.split('/')[0])
  }
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(tarBinary(), ['-tzf', file], { windowsHide: true })
      let stderr = ''
      let tail = ''
      child.stderr.on('data', (c) => {
        stderr += c.toString()
      })
      child.stdout.on('data', (c) => {
        const lines = (tail + c.toString()).split('\n')
        tail = lines.pop()
        for (const line of lines) sawEntry(line)
      })
      child.on('error', (err) =>
        reject(new Error(err.code === 'ENOENT'
          ? 'tar was not found on PATH (Windows 10/11 ships tar.exe in System32)'
          : err.message)))
      child.on('exit', (code) => {
        sawEntry(tail)
        if (code === 0) resolve()
        else reject(new Error(stderr.trim().split(/\r?\n/)[0] || `tar exited ${code}`))
      })
    })
  } catch (err) {
    problems.push(`the archive does not read back: ${err.message}`)
  }

  let missing = []
  if (!problems.length) {
    if (!entries) problems.push('the archive reads back but holds no entries')
    // Only checked when the walk succeeded: a truncated archive's partial listing would report
    // every later member missing, which buries the actual finding under its consequences.
    missing = expectedMembers.filter((m) => !roots.has(String(m).replace(/\\/g, '/').split('/')[0]))
    for (const member of missing) {
      problems.push(`the manifest lists "${member}" but the archive does not contain it`)
    }
  }
  return { ok: problems.length === 0, size, entries, missing, problems }
}

export async function verifySnapshot(name, ref) {
  const snap = resolveSnapshot(name, ref)
  const result = await verifyArchive(snap.path, snap.members)
  // No manifest means the member check was vacuous, not that it passed. Said, so an "ok" on a
  // manifest-less archive is read at its actual strength.
  const hasManifest = fs.existsSync(snap.path.replace(/\.tar\.gz$/, '.json'))
  return { snapshot: snap, hasManifest, ...result }
}

/**
 * Delete one snapshot, and the manifest that describes it.
 *
 * <p>Both or neither: a manifest without its archive is a row in the history that cannot be
 * restored, and an archive without its manifest loses the record of what is inside it.
 */
export function removeSnapshot(name, ref) {
  const snap = resolveSnapshot(name, ref)
  fs.rmSync(snap.path, { force: true })
  fs.rmSync(snap.path.replace(/\.tar\.gz$/, '.json'), { force: true })
  mirrorRemove(name, snap.name)
  return { removed: snap.name, size: snap.size }
}

/**
 * Trim a server's snapshots down to a limit.
 *
 * <p>`only` narrows it to snapshots carrying one label, and the scheduler always passes it.
 * Retention is a rule about the automatic backups a schedule produces, not a licence to delete
 * everything else in the folder - and everything else is where the important ones live. A
 * `pre-rebuild` snapshot is the single copy of a world taken before it was wiped, and a `manual`
 * one was taken because somebody was about to try something. An hourly task set to keep 5 would
 * have deleted both within five hours of them being made.
 */
export function pruneSnapshots(name, keep, { only = null, taskId = null } = {}) {
  const all = listSnapshots(name).filter((s) => {
    if (only && s.label !== only) return false
    // A limit belongs to the task that set it. Two scheduled backups on one server - a nightly
    // keeping 7 and a weekly archive keeping 8 - were drawing from the same pool, so whichever ran
    // next applied its own number to the other's snapshots and the smaller limit always won. The
    // weekly archive could never accumulate eight weeks of anything.
    if (taskId && s.taskId !== taskId) return false
    return true
  })
  const remove = all.slice(keep)
  for (const snap of remove) {
    fs.rmSync(snap.path, { force: true })
    fs.rmSync(snap.path.replace(/\.tar\.gz$/, '.json'), { force: true })
    mirrorRemove(name, snap.name)
  }
  return remove
}
