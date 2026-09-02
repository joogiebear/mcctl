/**
 * Mojang's own server jar, from the launcher's version manifest.
 *
 * <p>The manifest lists every version with a link to its metadata; the metadata names the
 * server download with its sha1. Vanilla loads no plugins and no mods, so an instance made
 * from here has nothing for the content tab to manage - which the software table says.
 *
 * <p>The metadata also says which Java the version needs, and that is passed up: Minecraft
 * has raised its floor twice in three years, and a server that refuses to start on the Java
 * that ran last year's is better explained before the download than after it.
 */
import fs from 'node:fs'
import path from 'node:path'

import { JARS_DIR } from './paths.mjs'
import { fail } from './util.mjs'
import { fetchJson, downloadFile } from './download.mjs'

const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const LABEL = 'Mojang’s version manifest'

async function manifest() {
  return fetchJson(MANIFEST, { label: LABEL })
}

/** Release versions, newest first, as Mojang lists them. */
export async function versions({ includeSnapshots = false } = {}) {
  const data = await manifest()
  return (data.versions ?? [])
    .filter((v) => includeSnapshots || v.type === 'release')
    .map((v) => v.id)
}

export function jarName(id) {
  return `vanilla-${id}.jar`
}

export async function fetchServer(id, { force = false, onProgress = null } = {}) {
  const entry = (await manifest()).versions?.find((v) => v.id === id)
  if (!entry) fail(`Mojang lists no Minecraft version ${id}.`)

  fs.mkdirSync(JARS_DIR, { recursive: true })
  const name = jarName(id)
  const dest = path.join(JARS_DIR, name)
  const meta = await fetchJson(entry.url, { label: `the metadata for ${id}` })
  const javaMajor = meta.javaVersion?.majorVersion ?? null
  if (fs.existsSync(dest) && !force) {
    onProgress?.({ received: 1, total: 1, cached: true })
    return { name, path: dest, version: id, javaMajor, cached: true }
  }
  const dl = meta.downloads?.server
  if (!dl?.url) fail(`Minecraft ${id} publishes no server jar.`)
  const { size, sizeHuman } = await downloadFile(dl.url, dest, {
    hash: 'sha1',
    expected: dl.sha1 ?? null,
    onProgress,
    minBytes: 1024 * 1024,
    label: name,
  })
  return { name, path: dest, version: id, javaMajor, cached: false, size, sizeHuman }
}
