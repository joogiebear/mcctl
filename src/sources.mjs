/**
 * Where each kind of server comes from: the version list to offer, and the fetch that turns a
 * chosen version into a jar in the store.
 *
 * <p>The metadata - what a loader loads, which Modrinth facet, the blurb - lives in
 * software.mjs so it can be imported without pulling in every download client. This file is
 * the other half: the clients, keyed the same way, behind one shape so the CLI's `new` and
 * the panel's create can loop over ids instead of growing a branch per project.
 *
 * <p>Every fetch answers `{ name, cached, ... }` where `name` is the jar now in the store, and
 * takes `{ onProgress, java, build, force }`. Progress arrives in one of two shapes - byte
 * counts from a download (`received`, `total`) or a line of narration (`message`) from a
 * build or an installer - and callers show whichever they get.
 */
import * as paper from './paper.mjs'
import * as purpur from './purpur.mjs'
import * as asp from './asp.mjs'
import * as vanilla from './vanilla.mjs'
import * as buildtools from './buildtools.mjs'
import * as fabric from './fabric.mjs'
import * as neoforge from './neoforge.mjs'
import { JAR_IDS, softwareOf } from './software.mjs'

const JAR_SOURCES = {
  paper: {
    versions: () => paper.versions(),
    fetch: (v, o) => paper.fetchBuild(v, o.build ?? null, o),
  },
  folia: {
    versions: () => paper.versions({ project: 'folia' }),
    fetch: (v, o) => paper.fetchBuild(v, o.build ?? null, { ...o, project: 'folia' }),
  },
  purpur: {
    versions: () => purpur.versions(),
    fetch: (v, o) => purpur.fetchBuild(v, o.build ?? null, o),
  },
  asp: {
    versions: () => asp.versions(),
    fetch: (v, o) => asp.fetchBuild(v, o),
  },
  vanilla: {
    versions: () => vanilla.versions(),
    fetch: (v, o) => vanilla.fetchServer(v, o),
  },
  spigot: {
    versions: () => buildtools.versions(),
    fetch: (v, o) => buildtools.build(v, { ...o, flavour: 'spigot' }),
  },
  craftbukkit: {
    versions: () => buildtools.versions(),
    fetch: (v, o) => buildtools.build(v, { ...o, flavour: 'craftbukkit' }),
  },
  fabric: {
    versions: () => fabric.versions(),
    fetch: (v, o) => fabric.fetchLauncher(v, o),
  },
}

for (const id of JAR_IDS) {
  if (!JAR_SOURCES[id]) throw new Error(`software.mjs lists "${id}" but sources.mjs has no client for it`)
}

/** Whether `new --<id>` and the panel's Software list should offer this as a jar source. */
export function isJarSource(id) {
  return Object.hasOwn(JAR_SOURCES, id)
}

/** The version list for any software id, NeoForge included. */
export async function versionsFor(id) {
  if (id === 'neoforge') return neoforge.versions()
  if (!isJarSource(id)) throw new Error(`no version list for "${id}"`)
  return JAR_SOURCES[id].versions()
}

export async function fetchJar(id, version, options = {}) {
  if (!isJarSource(id)) throw new Error(`"${id}" is not fetched as a jar`)
  return JAR_SOURCES[id].fetch(String(version), options)
}

/** The label a message should use for the thing being fetched. */
export function labelFor(id) {
  return softwareOf(id).label
}
