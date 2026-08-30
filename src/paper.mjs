import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { JARS_DIR } from './paths.mjs'
import { fail, humanBytes } from './util.mjs'

/**
 * PaperMC downloads, against the v3 "fill" API.
 *
 * The old api.papermc.io/v2 endpoints are sunset — they answer every request with
 * {"ok":false,"error":"sunset"} rather than a 404, so code written against them fails in a way
 * that reads like a network problem rather than a removed API. Everything here uses
 * fill.papermc.io/v3, which is the current one.
 */
const API = 'https://fill.papermc.io/v3/projects/paper'

// The API asks for a descriptive agent so they can contact operators of misbehaving clients.
const HEADERS = { 'User-Agent': 'mcctl (github.com/joogiebear/mcctl)', Accept: 'application/json' }

async function api(url) {
  let res
  try {
    res = await fetch(url, { headers: HEADERS })
  } catch (err) {
    fail(`could not reach the PaperMC API: ${err.message}`)
  }
  if (!res.ok) fail(`PaperMC API returned ${res.status} for ${url}`)
  return res.json()
}

/**
 * Every Minecraft version Paper publishes, newest first.
 *
 * The API groups them by minor ("1.21": ["1.21.11", ...]) and, within a group, lists newest first.
 * Flattening preserves that order, so the first entry is always the newest release.
 */
export async function versions({ includeUnstable = false } = {}) {
  const data = await api(API)
  const out = []
  for (const group of Object.values(data.versions ?? {})) {
    for (const v of group) {
      // Release candidates and pre-releases are published alongside releases; they are not what
      // anyone means by "latest" unless they say so.
      if (!includeUnstable && /-(rc|pre)/i.test(v)) continue
      out.push(v)
    }
  }
  return out
}

/** Builds for a version, newest first, each with its download URL and checksum. */
export async function builds(version) {
  const data = await api(`${API}/versions/${encodeURIComponent(version)}/builds`)
  return data.map((b) => {
    const dl = b.downloads?.['server:default']
    return {
      build: b.id,
      channel: b.channel,
      time: b.time,
      name: dl?.name ?? null,
      url: dl?.url ?? null,
      sha256: dl?.checksums?.sha256 ?? null,
      size: dl?.size ?? 0,
    }
  })
}

/**
 * The build to use for a version when the caller does not name one.
 *
 * Prefers the newest STABLE build. Paper marks experimental builds on a new Minecraft version as
 * EXPERIMENTAL until it settles, and silently handing someone an experimental server jar because it
 * happened to be newest is how a test environment becomes an unexplained bug report. Falls back to
 * the newest build of any channel when a version has no stable one yet, saying so.
 */
export async function resolveBuild(version, wanted = null) {
  const all = await builds(version)
  if (!all.length) fail(`Paper has no builds for version ${version}.`)
  if (wanted != null) {
    const hit = all.find((b) => String(b.build) === String(wanted))
    if (!hit) fail(`Paper ${version} has no build ${wanted}. Newest is ${all[0].build}.`)
    return hit
  }
  return all.find((b) => b.channel === 'STABLE') ?? all[0]
}

/**
 * Download a Paper build into the jars store and verify it.
 *
 * The checksum is not ceremony: a truncated download produces a jar that unzips far enough to look
 * plausible and then fails at runtime with a class-loading error that says nothing about the real
 * cause. Verified before it is put in place, so a bad download never becomes a stored jar.
 */
export async function fetchBuild(version, wanted = null, { force = false, onProgress = null } = {}) {
  const build = await resolveBuild(version, wanted)
  if (!build.url) fail(`Paper ${version} build ${build.build} publishes no server jar.`)

  fs.mkdirSync(JARS_DIR, { recursive: true })
  const dest = path.join(JARS_DIR, build.name)
  if (fs.existsSync(dest) && !force) {
    onProgress?.({ received: build.size, total: build.size, cached: true })
    return { ...build, path: dest, cached: true }
  }

  const tmp = `${dest}.part`
  const res = await fetch(build.url, { headers: { 'User-Agent': HEADERS['User-Agent'] } })
  if (!res.ok || !res.body) fail(`download failed (${res.status}) for ${build.url}`)

  const hash = crypto.createHash('sha256')
  const source = Readable.fromWeb(res.body)
  // The panel reports this to someone watching a progress bar, so it is measured from the bytes
  // that actually arrive rather than estimated. A server jar is ~50MB on a home connection: long
  // enough that silence reads as a hang.
  let received = 0
  const total = Number(res.headers.get('content-length')) || build.size || 0
  source.on('data', (chunk) => {
    hash.update(chunk)
    received += chunk.length
    onProgress?.({ received, total })
  })
  await pipeline(source, fs.createWriteStream(tmp))

  const got = hash.digest('hex')
  if (build.sha256 && got !== build.sha256) {
    fs.rmSync(tmp, { force: true })
    fail(`checksum mismatch for ${build.name}\n  expected ${build.sha256}\n  got      ${got}`)
  }
  // Rename only after the hash matches, so an interrupted or corrupt download leaves a .part file
  // rather than a jar that looks stored and is not.
  fs.renameSync(tmp, dest)
  return { ...build, path: dest, cached: false, sizeHuman: humanBytes(build.size) }
}
