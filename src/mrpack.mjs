/**
 * Modrinth modpacks (.mrpack), as servers.
 *
 * <p>An .mrpack is a zip holding one honest manifest and two override folders:
 * `modrinth.index.json` lists every file the pack needs - path, hashes, download URLs, and
 * whether the server side wants it at all - and names the Minecraft version and loader the
 * pack was built against. `overrides/` and `server-overrides/` are config laid on top, the
 * second winning where they collide.
 *
 * <p>The flow here downloads and validates EVERYTHING it can before an instance exists, so
 * "this pack needs NeoForge" or a dead download URL costs nothing but time. Only once the
 * pack is proven installable is the instance created - and if laying the files in fails
 * partway, the half-built instance is torn down rather than left looking created.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'

import { modrinthRequest, pickVersion, primaryFile, extractZip, recordManaged, readZipEntry } from './plugins.mjs'
import * as fabric from './fabric.mjs'
import * as create from './create.mjs'
import { removeInstance } from './registry.mjs'
import { fail, UserError, writeJson } from './util.mjs'

/** The provenance record for a whole pack, written into the instance root. */
export const PACK_FILE = '.mcctl-pack.json'

/**
 * What the index says, reduced to what the install needs - and refused early when it names
 * a loader mcctl cannot run yet. Exported pure, so the refusals are testable without a pack.
 */
export function parseIndex(index) {
  if (!index || index.game !== 'minecraft' || !Array.isArray(index.files)) {
    fail('that file does not look like a Modrinth modpack index')
  }
  const deps = index.dependencies ?? {}
  const mc = deps.minecraft
  if (!mc) fail('the pack names no Minecraft version')
  for (const other of ['neoforge', 'forge', 'quilt-loader']) {
    if (deps[other]) {
      fail(`this pack is built for ${other.replace('-loader', '')}, which mcctl cannot run yet - Fabric packs only for now`)
    }
  }
  const fabricLoader = deps['fabric-loader']
  if (!fabricLoader) fail('the pack names no Fabric loader version')

  const files = index.files
    .filter((f) => f.env?.server !== 'unsupported')
    .map((f) => ({
      path: String(f.path).replace(/\\/g, '/'),
      sha1: f.hashes?.sha1 ?? null,
      url: Array.isArray(f.downloads) ? f.downloads[0] : null,
      size: f.fileSize ?? 0,
    }))
  for (const f of files) {
    // Paths come from the pack author. Confined here once, so nothing later has to re-decide.
    if (f.path.startsWith('/') || /^[a-z]:/i.test(f.path) || f.path.split('/').includes('..')) {
      fail(`the pack lists a file outside its own folder ("${f.path}"); refusing the whole pack`)
    }
    if (!f.url) fail(`the pack gives no download for "${f.path}"`)
  }
  return {
    name: index.name || 'modpack',
    versionId: index.versionId || null,
    mc,
    fabricLoader,
    files,
    skipped: index.files.length - files.length,
  }
}

async function download(url, { timeoutMs = 180000 } = {}) {
  let res
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    throw new UserError(`download failed: ${err.cause?.message || err.message} (${url})`)
  }
  if (!res.ok) throw new UserError(`download failed: ${res.status} for ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * Build a new server from a Modrinth modpack, end to end.
 *
 * <p>Progress lands on `onProgress({ message, percent })` - a pack is dozens of downloads,
 * and dozens of downloads with no narration reads as a hang.
 */
export async function createFromModpack(name, projectId, {
  memory = '4G', port = null, onlineMode = true, onProgress = () => {},
} = {}) {
  // ---- resolve and fetch the pack itself, before anything exists ------------
  onProgress({ message: 'Finding the pack on Modrinth', percent: null })
  const versions = await modrinthRequest(`/project/${encodeURIComponent(projectId)}/version?${new URLSearchParams({ loaders: JSON.stringify(['fabric']) })}`)
  const version = pickVersion(versions, { loaders: ['fabric'] })
  if (!version) fail('that pack has no Fabric release mcctl can install')
  const packFile = primaryFile(version)
  if (!packFile) fail('that pack version has no downloadable file')

  onProgress({ message: `Downloading ${packFile.filename}`, percent: null })
  const packBytes = await download(packFile.url)
  if (packFile.hashes?.sha1) {
    const got = crypto.createHash('sha1').update(packBytes).digest('hex')
    if (got !== packFile.hashes.sha1) fail('the pack download did not match its checksum; nothing was installed')
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-mrpack-'))
  const mrpack = path.join(tmp, 'pack.mrpack')
  fs.writeFileSync(mrpack, packBytes)

  const rawIndex = readZipEntry(mrpack, 'modrinth.index.json')
  if (!rawIndex) fail('the pack has no modrinth.index.json - it is not an mrpack')
  const index = parseIndex(JSON.parse(rawIndex.toString('utf8')))

  // ---- everything the pack needs, downloaded and verified up front ----------
  onProgress({ message: `Fetching Fabric ${index.fabricLoader} for ${index.mc}`, percent: null })
  const launcher = await fabric.fetchLauncher(index.mc, { loader: index.fabricLoader })

  const staged = []
  for (let i = 0; i < index.files.length; i++) {
    const f = index.files[i]
    onProgress({
      message: `Downloading ${path.posix.basename(f.path)} (${i + 1} of ${index.files.length})`,
      percent: Math.round((i / Math.max(1, index.files.length)) * 100),
    })
    const bytes = await download(f.url)
    if (f.sha1) {
      const got = crypto.createHash('sha1').update(bytes).digest('hex')
      if (got !== f.sha1) fail(`"${f.path}" did not match the checksum the pack published; nothing was installed`)
    }
    staged.push({ ...f, bytes })
  }

  // ---- only now does the instance exist -------------------------------------
  onProgress({ message: 'Creating the server', percent: null })
  const inst = await create.newInstance(name, {
    jar: launcher.name,
    loader: 'fabric',
    memory,
    port,
    onlineMode,
    acceptEula: true,
    motd: index.name,
  })

  try {
    for (const f of staged) {
      const target = path.join(inst.dir, ...f.path.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, f.bytes)
      // Pack-owned mods are managed BY THE PACK: shown in the Mods tab, but never offered an
      // individual update - updating one mod out of a pack is how packs break.
      if (f.path.startsWith('mods/') && f.path.endsWith('.jar') && !f.path.slice(5).includes('/')) {
        recordManaged(inst, path.posix.basename(f.path), {
          source: 'modpack',
          project: String(projectId),
          version: version.version_number,
          installedAt: new Date().toISOString(),
        })
      }
    }
    onProgress({ message: 'Applying the pack’s configuration', percent: null })
    const strip = (prefix) => (entryName) =>
      entryName.startsWith(prefix) ? entryName.slice(prefix.length) : null
    const laid = extractZip(mrpack, inst.dir, { mapPath: strip('overrides/') })
    const laidServer = extractZip(mrpack, inst.dir, { mapPath: strip('server-overrides/') })

    writeJson(path.join(inst.dir, PACK_FILE), {
      project: String(projectId),
      versionId: index.versionId,
      versionNumber: version.version_number,
      name: index.name,
      mc: index.mc,
      fabricLoader: index.fabricLoader,
      installedAt: new Date().toISOString(),
      files: [...index.files.map((f) => f.path), ...laid, ...laidServer],
      skippedClientOnly: index.skipped,
    })
  } catch (err) {
    // A half-laid pack must not sit there looking like a server. The instance was created by
    // this call, so this call cleans it up before failing.
    try {
      removeInstance(name)
      fs.rmSync(inst.dir, { recursive: true, force: true })
    } catch {
      /* the original error is the one worth reporting */
    }
    throw err
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  return {
    name,
    pack: index.name,
    packVersion: version.version_number,
    mc: index.mc,
    fabricLoader: index.fabricLoader,
    files: index.files.length,
    skippedClientOnly: index.skipped,
    port: inst.port,
  }
}

/** The pack record for an instance, or null for a server no pack built. */
export function packOf(inst) {
  try {
    return JSON.parse(fs.readFileSync(path.join(inst.dir, PACK_FILE), 'utf8'))
  } catch {
    return null
  }
}
