import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { BACKUPS_DIR } from './paths.mjs'
import { readProps, worldDirs } from './props.mjs'
import { fail, stamp, humanBytes, writeJson, readJson, UserError } from './util.mjs'

export const SCOPES = ['plugins', 'worlds', 'config', 'standard', 'full']

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

  const plugins = exists('plugins') ? ['plugins'] : []
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

function runTar(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { cwd, windowsHide: true })
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

export async function createSnapshot(inst, { scope = 'standard', label = null, running = false } = {}) {
  const members = membersFor(inst, scope)
  if (!members.length) fail(`nothing to back up for scope "${scope}" in ${inst.dir}`)

  const slug = label ? `${label.replace(/[^a-z0-9_-]/gi, '-')}_` : ''
  const base = `${slug}${scope}_${stamp()}`
  const file = path.join(backupDir(inst.name), `${base}.tar.gz`)

  const { stderr } = await runTar(['-czf', file, ...members], inst.dir)

  const size = fs.statSync(file).size
  const manifest = {
    instance: inst.name,
    scope,
    label,
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
  return { file, size, members, manifest }
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

export function pruneSnapshots(name, keep) {
  const all = listSnapshots(name)
  const remove = all.slice(keep)
  for (const snap of remove) {
    fs.rmSync(snap.path, { force: true })
    fs.rmSync(snap.path.replace(/\.tar\.gz$/, '.json'), { force: true })
  }
  return remove
}
