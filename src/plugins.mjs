/**
 * Plugins: what a server has, and what Modrinth can give it.
 *
 * <p>Everything a jar says about itself lives in its plugin.yml (or paper-plugin.yml), which
 * sits inside a zip. mcctl ships no dependencies, so the zip is read here by hand - the format
 * is stable, the entry wanted is tiny, and zlib's inflateRaw is built into node. Only the
 * bytes needed are read: the end-of-central-directory record, the central directory, and the
 * one entry - never the whole of a fifty-megabyte jar.
 *
 * <p>Disabling a plugin renames it to `<file>.disabled` in place. The server only loads
 * `*.jar`, so the file stays exactly where it was, keeps its config folder, and comes back
 * with a rename - no second folder to keep in sync.
 *
 * <p>Modrinth is the install source: open API, no key, and version metadata that says which
 * game versions and loaders a build supports - so "this does not run on your server" is
 * caught before the download. Everything network-facing degrades to a readable error;
 * the installed list works with no network at all.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { fail, UserError, readJson, writeJson } from './util.mjs'

// ---- reading one entry out of a zip -----------------------------------------

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

/**
 * Find the end-of-central-directory record. It sits at the very end of the file, behind an
 * optional comment of up to 64 KiB, so the search reads only that tail.
 */
function readEocd(fd, size) {
  const tailSize = Math.min(size, 22 + 65535)
  const tail = Buffer.alloc(tailSize)
  fs.readSync(fd, tail, 0, tailSize, size - tailSize)
  for (let i = tailSize - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      return {
        entries: tail.readUInt16LE(i + 10),
        cdSize: tail.readUInt32LE(i + 12),
        cdOffset: tail.readUInt32LE(i + 16),
      }
    }
  }
  return null
}

/**
 * Read one named entry from a zip, or null when it is not there.
 *
 * <p>Zip64 archives report 0xffffffff sizes and are declined rather than misread - a
 * plugin.yml has never needed four gigabytes.
 */
export function readZipEntry(file, wanted) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const eocd = readEocd(fd, size)
    if (!eocd || eocd.cdOffset === 0xffffffff) return null

    const cd = Buffer.alloc(eocd.cdSize)
    fs.readSync(fd, cd, 0, eocd.cdSize, eocd.cdOffset)

    let at = 0
    for (let n = 0; n < eocd.entries && at + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(at) !== CENTRAL_SIG) break
      const method = cd.readUInt16LE(at + 10)
      const compressed = cd.readUInt32LE(at + 20)
      const nameLen = cd.readUInt16LE(at + 28)
      const extraLen = cd.readUInt16LE(at + 30)
      const commentLen = cd.readUInt16LE(at + 32)
      const localOffset = cd.readUInt32LE(at + 42)
      const name = cd.toString('utf8', at + 46, at + 46 + nameLen)

      if (name === wanted) {
        if (compressed === 0xffffffff || localOffset === 0xffffffff) return null
        // The local header repeats the name and extra field, and the extra field there can
        // differ in length from the central one - so it is read, not assumed.
        const local = Buffer.alloc(30)
        fs.readSync(fd, local, 0, 30, localOffset)
        if (local.readUInt32LE(0) !== LOCAL_SIG) return null
        const dataAt = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
        const data = Buffer.alloc(compressed)
        fs.readSync(fd, data, 0, compressed, dataAt)
        if (method === 0) return data
        if (method === 8) return zlib.inflateRawSync(data)
        return null
      }
      at += 46 + nameLen + extraLen + commentLen
    }
    return null
  } finally {
    fs.closeSync(fd)
  }
}

// ---- just enough YAML -------------------------------------------------------

/**
 * The top-level scalars and simple lists of a plugin.yml.
 *
 * <p>Not a YAML parser - a reader for the handful of fields a plugin manifest actually uses.
 * Nested blocks (commands, permissions) are skipped whole; folded scalars keep their first
 * following lines; flow and block lists become arrays. Anything it cannot read it leaves
 * out, and a missing field is normal.
 */
export function parsePluginYml(text) {
  const out = {}
  const lines = String(text).split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || /^\s/.test(line) || line.startsWith('#')) continue
    const m = /^([\w.-]+):\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    let value = m[2].trim()

    if (value === '' || value === '|' || value === '>' || value === '|-' || value === '>-') {
      // A block: either a list, a folded scalar, or a nested map (which is skipped).
      const block = []
      let j = i + 1
      while (j < lines.length && (/^\s/.test(lines[j]) || lines[j] === '')) {
        if (lines[j].trim()) block.push(lines[j].trim())
        j++
      }
      if (block.every((b) => b.startsWith('- '))) {
        out[key] = block.map((b) => unquote(b.slice(2)))
      } else if (value !== '' && block.length) {
        out[key] = block.join(' ')
      }
      continue
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      out[key] = value.slice(1, -1).split(',').map((v) => unquote(v)).filter(Boolean)
      continue
    }
    out[key] = unquote(value)
  }
  return out
}

function unquote(v) {
  const t = String(v).trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1)
  }
  return t
}

// ---- the installed list -----------------------------------------------------

const DISABLED = '.disabled'

function pluginsDir(inst) {
  return path.join(inst.dir, 'plugins')
}

// ---- what mcctl itself installed --------------------------------------------

/**
 * Provenance: which jars in this folder mcctl put there, and from where.
 *
 * <p>The distinction carries the whole feature. A jar somebody dropped in by hand - a custom
 * build, a premium plugin bought elsewhere - is theirs: it would never show an update, its
 * hash must not be sent to Modrinth to ask, and a manager that lists it anyway is claiming
 * jurisdiction it does not have. So mcctl manages exactly what it installed, records that
 * here, and leaves everything else alone.
 *
 * <p>The record lives IN the plugins folder (the server ignores non-jar files), so a
 * plugins-scope snapshot carries it and a restore keeps the managed set consistent with the
 * jars beside it.
 */
const STORE = '.mcctl-plugins.json'

export function readManaged(inst) {
  const store = readJson(path.join(pluginsDir(inst), STORE), null)
  return store && typeof store.managed === 'object' && store.managed ? store : { version: 1, managed: {} }
}

function writeManaged(inst, store) {
  writeJson(path.join(pluginsDir(inst), STORE), store)
}

export function recordManaged(inst, file, meta) {
  const store = readManaged(inst)
  store.managed[file] = meta
  writeManaged(inst, store)
}

export function forgetManaged(inst, file) {
  const store = readManaged(inst)
  if (Object.hasOwn(store.managed, file)) {
    delete store.managed[file]
    writeManaged(inst, store)
  }
}

/** A rename (enable/disable, or an update that changed the filename) moves the record along. */
function moveManaged(inst, from, to) {
  const store = readManaged(inst)
  if (Object.hasOwn(store.managed, from)) {
    store.managed[to] = store.managed[from]
    delete store.managed[from]
    writeManaged(inst, store)
  }
}

/** The Minecraft version this server runs, read from its jar's filename; null when unclear. */
export function mcVersionOf(inst) {
  const m = /^(?:paper|purpur|folia|spigot|craftbukkit)-(\d+\.\d+(?:\.\d+)?)/i.exec(inst.jar || '')
  return m ? m[1] : null
}

/**
 * Every plugin jar this server has, enabled or not, with what its manifest says about it.
 *
 * <p>A jar with no readable manifest still appears - it is on disk and will be loaded (or
 * refused) by the server, and hiding it from the one screen that manages plugins would make
 * that screen lie. It simply carries no name beyond its filename.
 */
export function listPlugins(inst) {
  const dir = pluginsDir(inst)
  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  const store = readManaged(inst)
  const rows = []
  for (const file of entries) {
    const enabled = file.endsWith('.jar')
    if (!enabled && !file.endsWith(`.jar${DISABLED}`)) continue
    const full = path.join(dir, file)
    let meta = {}
    try {
      const yml = readZipEntry(full, 'plugin.yml') ?? readZipEntry(full, 'paper-plugin.yml')
      if (yml) meta = parsePluginYml(yml.toString('utf8'))
    } catch {
      /* an unreadable jar is still listed by filename */
    }
    const st = fs.statSync(full)
    const record = store.managed[file] ?? null
    rows.push({
      file,
      enabled,
      // Managed means mcctl installed it and may update it. A jar dropped in by hand is the
      // person's own - listed here for the CLI's inventory, but never offered management.
      managed: Boolean(record),
      source: record?.source ?? null,
      project: record?.project ?? null,
      name: meta.name || file.replace(/\.jar(\.disabled)?$/, ''),
      version: meta.version || null,
      description: meta.description || null,
      authors: meta.authors || (meta.author ? [meta.author] : []),
      apiVersion: meta['api-version'] || null,
      website: meta.website || null,
      size: st.size,
      mtime: st.mtime,
    })
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

/** Flip one plugin on or off by renaming it in place. Takes effect at the next start. */
export function setPluginEnabled(inst, file, enabled) {
  const dir = pluginsDir(inst)
  const current = safePluginPath(dir, file)
  const isOn = file.endsWith('.jar')
  if (isOn === Boolean(enabled)) return { file, enabled: isOn }
  const next = enabled ? file.slice(0, -DISABLED.length) : `${file}${DISABLED}`
  fs.renameSync(current, path.join(dir, next))
  moveManaged(inst, file, next)
  return { file: next, enabled: Boolean(enabled) }
}

export function removePlugin(inst, file) {
  const dir = pluginsDir(inst)
  fs.rmSync(safePluginPath(dir, file), { force: true })
  forgetManaged(inst, file)
  return { removed: file }
}

/**
 * The file must be a plain name inside the plugins folder. The name arrives over HTTP, and a
 * path that walks out of the folder would turn "delete a plugin" into "delete anything".
 */
function safePluginPath(dir, file) {
  const name = String(file)
  if (!/^[^\\/]+\.jar(\.disabled)?$/.test(name) || name.includes('..')) {
    fail(`"${file}" is not a plugin file name`)
  }
  const full = path.join(dir, name)
  if (!fs.existsSync(full)) fail(`no plugin file "${name}" in ${dir}`)
  return full
}

// ---- Modrinth ---------------------------------------------------------------

const MODRINTH = 'https://api.modrinth.com/v2'
// The loaders a Paper server can actually load. Paper runs Spigot and Bukkit plugins, so a
// build published for those is as installable as one published for Paper itself.
export const LOADERS = ['paper', 'spigot', 'bukkit', 'folia']

async function modrinth(pathname, init) {
  let res
  try {
    res = await fetch(`${MODRINTH}${pathname}`, {
      ...init,
      headers: {
        // Modrinth asks every client to say who it is.
        'user-agent': 'joogiebear/mcctl (github.com/joogiebear/mcctl)',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
      signal: AbortSignal.timeout(15000),
    })
  } catch (err) {
    throw new UserError(`could not reach Modrinth: ${err.cause?.message || err.message}`)
  }
  if (!res.ok) throw new UserError(`Modrinth answered ${res.status} for ${pathname}`)
  return res.json()
}

/** Search Modrinth for plugins this kind of server can load. */
export async function searchPlugins(query, { gameVersion = null, limit = 20 } = {}) {
  const facets = [
    ['project_type:plugin'],
    LOADERS.map((l) => `categories:${l}`),
  ]
  if (gameVersion) facets.push([`versions:${gameVersion}`])
  const params = new URLSearchParams({
    query: String(query ?? ''),
    facets: JSON.stringify(facets),
    limit: String(limit),
    index: 'relevance',
  })
  const data = await modrinth(`/search?${params}`)
  return data.hits.map((h) => ({
    id: h.project_id,
    slug: h.slug,
    title: h.title,
    description: h.description,
    downloads: h.downloads,
    icon: h.icon_url || null,
  }))
}

/**
 * Choose the version to install from what a project offers.
 *
 * <p>Newest first is Modrinth's order. The first release that supports one of our loaders
 * (and the server's game version, when known) wins; with nothing but pre-releases, the
 * newest compatible one of those is better than nothing and is labelled by its own type.
 */
export function pickVersion(versions, { gameVersion = null } = {}) {
  const fits = (v) =>
    v.loaders.some((l) => LOADERS.includes(l)) &&
    (!gameVersion || v.game_versions.includes(gameVersion))
  return versions.find((v) => v.version_type === 'release' && fits(v)) ?? versions.find(fits) ?? null
}

/** The downloadable file of a version: the one marked primary, else the first. */
export function primaryFile(version) {
  return version.files.find((f) => f.primary) ?? version.files[0] ?? null
}

/**
 * Download one project's best version into the plugins folder.
 *
 * <p>The bytes are checked against the sha1 Modrinth published before the file is allowed to
 * keep its name - a truncated or tampered download must not sit there looking installed.
 */
export async function installPlugin(inst, projectId, { gameVersion = null } = {}) {
  const params = new URLSearchParams({ loaders: JSON.stringify(LOADERS) })
  if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]))
  const versions = await modrinth(`/project/${encodeURIComponent(projectId)}/version?${params}`)
  const version = pickVersion(versions, { gameVersion })
  if (!version) {
    fail(gameVersion
      ? `no build of that plugin supports ${gameVersion} on a Paper-family server`
      : 'no build of that plugin supports a Paper-family server')
  }
  const file = primaryFile(version)
  if (!file) fail('that version has no downloadable file')

  let res
  try {
    res = await fetch(file.url, { signal: AbortSignal.timeout(120000) })
  } catch (err) {
    throw new UserError(`download failed: ${err.cause?.message || err.message}`)
  }
  if (!res.ok) throw new UserError(`download failed: ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())

  const wantSha = file.hashes?.sha1
  if (wantSha) {
    const got = crypto.createHash('sha1').update(bytes).digest('hex')
    if (got !== wantSha) fail('the download did not match the checksum Modrinth published; nothing was installed')
  }

  const dir = pluginsDir(inst)
  fs.mkdirSync(dir, { recursive: true })
  const name = path.basename(String(file.filename || `${projectId}.jar`))
  if (!/^[^\\/]+\.jar$/.test(name)) fail(`Modrinth offered a file named "${name}", which is not a plugin jar`)
  fs.writeFileSync(path.join(dir, name), bytes)
  // Recorded as mcctl's to manage. Only jars with a record here are ever listed by the panel,
  // offered updates, or have their hashes sent anywhere.
  recordManaged(inst, name, {
    source: 'modrinth',
    project: String(version.project_id ?? projectId),
    version: version.version_number,
    installedAt: new Date().toISOString(),
  })
  return { installed: name, version: version.version_number, size: bytes.length }
}

/**
 * Which of the jars MCCTL INSTALLED have a newer build, asked by hash.
 *
 * <p>Hashes rather than names, because a jar knows nothing reliable about where it came
 * from - Modrinth's version_files/update endpoint maps a file's sha1 straight to the latest
 * version of whatever project it belongs to.
 *
 * <p>Only managed jars are asked about, and that is a boundary, not an optimisation: a
 * custom or premium plugin somebody dropped in by hand is not mcctl's to update, and its
 * hash is not mcctl's to send to anyone.
 */
export async function checkUpdates(inst, { gameVersion = null } = {}) {
  const rows = listPlugins(inst).filter((p) => p.enabled && p.managed)
  if (!rows.length) return []
  const dir = pluginsDir(inst)
  const byHash = new Map()
  for (const p of rows) {
    const sha = sha1File(path.join(dir, p.file))
    byHash.set(sha, p)
  }
  const body = {
    hashes: [...byHash.keys()],
    algorithm: 'sha1',
    loaders: LOADERS,
    ...(gameVersion ? { game_versions: [gameVersion] } : {}),
  }
  const latest = await modrinth('/version_files/update', { method: 'POST', body: JSON.stringify(body) })

  const updates = []
  for (const [sha, p] of byHash) {
    const v = latest[sha]
    if (!v) continue
    const file = primaryFile(v)
    // Same hash means same file: already the newest.
    if (!file || file.hashes?.sha1 === sha) continue
    updates.push({
      file: p.file,
      name: p.name,
      installedVersion: p.version,
      latestVersion: v.version_number,
      projectId: v.project_id,
    })
  }
  return updates
}

function sha1File(file) {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')
}

/**
 * Replace one installed jar with its latest build. The old jar is deleted only after the new
 * one is fully on disk and checksummed - the failure mode must be "two jars, remove one",
 * never "no plugin at all".
 */
export async function updatePlugin(inst, file, { gameVersion = null } = {}) {
  const dir = pluginsDir(inst)
  const current = safePluginPath(dir, file)
  if (!Object.hasOwn(readManaged(inst).managed, file)) {
    fail('mcctl did not install this jar, so it will not touch it - custom and premium plugins are yours to update')
  }
  const sha = sha1File(current)
  const body = {
    hashes: [sha],
    algorithm: 'sha1',
    loaders: LOADERS,
    ...(gameVersion ? { game_versions: [gameVersion] } : {}),
  }
  const latest = await modrinth('/version_files/update', { method: 'POST', body: JSON.stringify(body) })
  const version = latest[sha]
  if (!version) fail('Modrinth does not recognise this jar, so it cannot update it')
  const newFile = primaryFile(version)
  if (!newFile) fail('the latest version has no downloadable file')
  if (newFile.hashes?.sha1 === sha) return { alreadyLatest: true, version: version.version_number }

  const res = await installPlugin(inst, version.project_id, { gameVersion })
  if (res.installed !== file) {
    fs.rmSync(current, { force: true })
    forgetManaged(inst, file)
  }
  return { updated: res.installed, from: file, version: res.version }
}
