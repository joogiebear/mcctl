import { execFile } from 'node:child_process'

/**
 * Is there a Java, and is it new enough?
 *
 * <p>Java is the one prerequisite mcctl cannot supply and cannot work without, and its absence used
 * to surface at the worst possible moment: after setup, after a fifty-megabyte download, on the
 * first press of Start, as `spawn java ENOENT` in a modal. Nothing in the app or the README
 * mentioned it. Someone downloading a desktop application has no reason to have a JDK, so this is
 * the single most likely thing to be wrong on a stranger's machine.
 *
 * <p>Checked here rather than in each caller so the wizard, the panel and `mcctl doctor` all answer
 * the same question the same way.
 */

/**
 * Minecraft 26.x needs 25 - Mojang's version metadata says so, and Paper follows it. 1.21.x ran
 * on 21 and older versions on 17, which is why 17 is the floor rather than the recommendation.
 */
export const RECOMMENDED_MAJOR = 25
export const MINIMUM_MAJOR = 17

/** Where to send someone who does not have it. A build, not a vendor download page behind a login. */
export const DOWNLOAD_URL = 'https://adoptium.net/temurin/releases/?version=25'

/**
 * Parse the major version out of what `java -version` prints.
 *
 * <p>Two shapes have to be understood: `openjdk version "21.0.5"` and the pre-9 `java version
 * "1.8.0_401"`, where the meaningful number is the second one.
 */
export function parseMajor(text) {
  const m = /version "(\d+)(?:\.(\d+))?[^"]*"/.exec(text)
  if (!m) return null
  const first = Number(m[1])
  if (first === 1) return m[2] ? Number(m[2]) : null
  return first
}

/**
 * Probe the Java on PATH, or a specific binary.
 *
 * <p>Returns a plain object rather than throwing: every caller wants to carry on and say something
 * about it, not abort. Asynchronous, because the panel asks at the moment it opens - the same
 * moment the first poll and the console stream start - and a JVM takes a few hundred milliseconds
 * to say its version.
 */
export async function probe(bin = 'java') {
  const res = await new Promise((resolve) => {
    execFile(bin, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 8000 },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }))
  })
  if (res.error) {
    // ENOENT is the common case by a mile, and "not installed" is more useful to read than the
    // error code for it. execFile puts an exit status in `code` too, as a number.
    const missing = res.error.code === 'ENOENT'
    return {
      ok: false,
      found: false,
      major: null,
      version: null,
      reason: missing ? 'not-installed' : 'unusable',
      message: missing
        ? 'Java is not installed, or not on PATH.'
        : `Java could not be run: ${typeof res.error.code === 'number' ? `exit ${res.error.code}` : res.error.message}`,
    }
  }

  // java -version writes to stderr. It has done so since 1995 and it is not going to change.
  const text = `${res.stderr ?? ''}${res.stdout ?? ''}`
  // The version line, not the first line: with JAVA_TOOL_OPTIONS set the JVM prints a "Picked up"
  // notice first, and that was being reported as the version.
  const version = (text.split('\n').find((l) => /version "/.test(l)) ?? text.split('\n')[0]).trim()
  const major = parseMajor(text)

  if (major == null) {
    return { ok: true, found: true, major: null, version, reason: 'unknown-version', message: `Found ${version}.` }
  }
  if (major < MINIMUM_MAJOR) {
    return {
      ok: false,
      found: true,
      major,
      version,
      reason: 'too-old',
      message: `Java ${major} is too old to run a modern Minecraft server. Version ${RECOMMENDED_MAJOR} is what current Paper needs.`,
    }
  }
  if (major < RECOMMENDED_MAJOR) {
    return {
      ok: true,
      found: true,
      major,
      version,
      reason: 'old',
      message: `Java ${major} will run older Minecraft versions, but current Paper needs ${RECOMMENDED_MAJOR}.`,
    }
  }
  return { ok: true, found: true, major, version, reason: 'ok', message: `Java ${major} is installed.` }
}
