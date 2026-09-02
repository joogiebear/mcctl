/**
 * Purpur downloads, against api.purpurmc.org.
 *
 * <p>A Paper fork, served the way Paper is: versions, builds per version, one jar per build, an
 * md5 beside it. The API lists versions oldest-first and builds oldest-first; both are reversed
 * here so "the first one" means the newest everywhere in mcctl.
 */
import fs from 'node:fs'
import path from 'node:path'

import { JARS_DIR } from './paths.mjs'
import { fail } from './util.mjs'
import { fetchJson, downloadFile } from './download.mjs'

const API = 'https://api.purpurmc.org/v2/purpur'
const LABEL = 'the Purpur API'

/** Every Minecraft version Purpur publishes, newest first. */
export async function versions() {
  const data = await fetchJson(API, { label: LABEL })
  return [...(data.versions ?? [])].reverse()
}

/** Build ids for a version, newest first, and which one the project calls latest. */
export async function builds(version) {
  const data = await fetchJson(`${API}/${encodeURIComponent(version)}`, { label: LABEL })
  const all = [...(data.builds?.all ?? [])].reverse()
  if (!all.length) fail(`Purpur has no builds for version ${version}.`)
  return { latest: String(data.builds.latest ?? all[0]), all }
}

export function jarName(version, build) {
  return `purpur-${version}-${build}.jar`
}

export async function fetchBuild(version, wanted = null, { force = false, onProgress = null } = {}) {
  const { latest, all } = await builds(version)
  const build = wanted != null ? String(wanted) : latest
  if (!all.includes(build)) fail(`Purpur ${version} has no build ${build}. Newest is ${latest}.`)

  fs.mkdirSync(JARS_DIR, { recursive: true })
  const name = jarName(version, build)
  const dest = path.join(JARS_DIR, name)
  if (fs.existsSync(dest) && !force) {
    onProgress?.({ received: 1, total: 1, cached: true })
    return { name, path: dest, version, build, cached: true }
  }

  const detail = await fetchJson(`${API}/${encodeURIComponent(version)}/${build}`, { label: LABEL })
  const { size, sizeHuman } = await downloadFile(`${API}/${encodeURIComponent(version)}/${build}/download`, dest, {
    hash: 'md5',
    expected: detail.md5 ?? null,
    onProgress,
    minBytes: 1024 * 1024,
    label: name,
  })
  return { name, path: dest, version, build, cached: false, size, sizeHuman }
}
