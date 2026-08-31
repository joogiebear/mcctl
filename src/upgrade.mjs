/**
 * Updating the server software itself.
 *
 * <p>Two different sizes of decision share this module, and the code keeps them apart the way
 * the panel does. A newer BUILD of the same Minecraft version is routine - bug fixes for the
 * server you already run, and the old jar stays in the instance folder as the way back. A
 * newer Minecraft VERSION is not routine: the first start migrates the worlds, and worlds do
 * not migrate back. Both end the same way mechanically - fetch, verify, place, point the
 * registry at it - but only one should ever happen without a person having read a warning.
 */
import * as paper from './paper.mjs'
import { placeJar, strayJars } from './create.mjs'
import { getInstance, updateInstance } from './registry.mjs'
import { createSnapshot } from './backup.mjs'
import { fail } from './util.mjs'

/** What a Paper jar's filename says it is: paper-26.2-121.jar → { version, build }. */
export function parsePaperJar(jar) {
  const m = /^paper-(\d+\.\d+(?:\.\d+)?)-(\d+)\.jar$/i.exec(String(jar ?? ''))
  return m ? { version: m[1], build: Number(m[2]) } : null
}

/** The versions newer than the current one, out of Paper's newest-first list. */
export function newerVersionsOf(all, current) {
  const at = all.indexOf(current)
  return at === -1 ? [] : all.slice(0, at)
}

/**
 * What is available for this server, asked of PaperMC on demand.
 *
 * <p>A server whose jar mcctl did not name (an adopted custom build) gets an honest null for
 * its current version rather than a guess, and only the version list - there is no way to say
 * "newer than" something unparseable.
 */
export async function checkUpgrade(inst) {
  const current = parsePaperJar(inst.jar)
  const all = await paper.versions()
  const out = {
    current,
    latestBuild: null,
    buildUpdate: false,
    newerVersions: current ? newerVersionsOf(all, current.version) : [],
    latestVersion: all[0] ?? null,
  }
  if (!current) return out
  const best = await paper.resolveBuild(current.version)
  out.latestBuild = { build: best.build, channel: best.channel, time: best.time }
  out.buildUpdate = Number(best.build) > current.build
  return out
}

/**
 * Fetch a build, place it in the instance, and point the registry at it.
 *
 * <p>The old jar is deliberately left in the instance folder - it is the way back if the new
 * build turns out to be wrong, and fifty megabytes is not a good enough reason to take that
 * away. It is named in the result so the caller can say so.
 */
export async function applyUpgrade(name, { version = null, build = null, running = false, onProgress = null } = {}) {
  const inst = getInstance(name)
  const current = parsePaperJar(inst.jar)
  const target = version ?? current?.version
  if (!target) {
    fail(`"${inst.jar}" is not a Paper jar mcctl can reason about - name a version: upgrade ${name} --version <v>`)
  }
  const crossVersion = Boolean(current && target !== current.version)

  const fetched = await paper.fetchBuild(target, build, { onProgress })
  if (fetched.name === inst.jar) return { alreadyCurrent: true, jar: inst.jar }

  // Crossing versions migrates the worlds on the next start, and worlds do not migrate back -
  // so the way back is made before the registry points anywhere new. After the fetch, so a
  // failed download never costs a snapshot; a build update needs none of this, because the
  // worlds are untouched and the old jar stays beside the new one.
  let snapshot = null
  if (crossVersion) {
    const snap = await createSnapshot(inst, { scope: 'standard', label: 'pre-upgrade', running })
    snapshot = snap.file
  }

  placeJar(inst.dir, fetched.name)
  updateInstance(name, { jar: fetched.name })
  return {
    from: inst.jar,
    to: fetched.name,
    version: target,
    build: fetched.build,
    channel: fetched.channel,
    crossVersion,
    snapshot,
    oldJars: strayJars(inst.dir, fetched.name).map((j) => j.name),
  }
}
