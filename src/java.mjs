import { execFile } from 'node:child_process'
import fsSync from 'node:fs'
import path from 'node:path'
import { fail, UserError } from './util.mjs'

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

const PROBE_TIMEOUT_MS = 8000

/** execFile's timeout kills the child and reports it as a signal, never as an exit code. */
function timedOut(error) {
  return Boolean(error && error.killed && error.code == null)
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
  const run = () => new Promise((resolve) => {
    execFile(bin, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: PROBE_TIMEOUT_MS },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }))
  })
  let res = await run()
  // A JVM that is slow to answer is not a JVM that is missing. Discovery starts every Java on the
  // machine at once, and on a loaded box - CI running twenty test files, a laptop mid-update - one
  // of them can take longer than the window just to print its version. Reporting that as "not
  // installed" flipped the default Java between two calls made seconds apart. So a timeout gets
  // one more try, on its own this time, before it counts against the binary.
  if (timedOut(res.error)) res = await run()
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
        : timedOut(res.error)
          ? `Java did not answer within ${PROBE_TIMEOUT_MS / 1000} seconds, twice.`
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

/**
 * Every Java on this machine, not just the one on PATH.
 *
 * <p>"Java is not installed" was being said to people who had just installed it. Three ways that
 * happens, all common: the Temurin installer's "add to PATH" box is optional and unticked by
 * default in some builds; a Java added to PATH is not seen by a program that was already running,
 * and the desktop app is exactly that program until it is restarted or the person signs out; and
 * Oracle's javapath shim in front of PATH points at an older runtime while the new one sits in
 * Program Files unused. Asking PATH alone answers all three wrongly.
 *
 * <p>So the usual install folders are looked in as well - every vendor's default location under
 * Program Files and the per-user Programs folder, JAVA_HOME, and PATH - and each candidate is
 * asked its version once, all at the same time. The result is what mcctl uses when a server has
 * not been pointed at a Java of its own.
 */
const WINDOWS_VENDOR_DIRS = [
  'Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'AdoptOpenJDK', 'Temurin', 'Microsoft',
  'Zulu', 'Amazon Corretto', 'BellSoft', 'Semeru', 'OpenJDK', 'Azul', 'Oracle',
]

function candidatePaths() {
  const fs = fsSync
  const found = new Map()
  const add = (p, source) => {
    if (!p) return
    let real = p
    try {
      real = fs.realpathSync(p)
    } catch {
      return
    }
    if (!found.has(real)) found.set(real, { path: p, source })
  }
  const bin = process.platform === 'win32' ? 'java.exe' : 'java'
  const home = process.env.JAVA_HOME
  if (home) add(path.join(home, 'bin', bin), 'JAVA_HOME')

  const scan = (root, source) => {
    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const base = path.join(root, e.name)
      // Either <vendor>/<jdk-25.0.1>/bin/java.exe or, for macOS bundles, .../Contents/Home/bin.
      for (const rel of [['bin', bin], ['Contents', 'Home', 'bin', bin]]) add(path.join(base, ...rel), source)
    }
  }
  if (process.platform === 'win32') {
    const roots = new Set([process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432,
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean))
    for (const root of roots) {
      for (const vendor of WINDOWS_VENDOR_DIRS) scan(path.join(root, vendor), vendor)
    }
  } else if (process.platform === 'darwin') {
    scan('/Library/Java/JavaVirtualMachines', 'JavaVirtualMachines')
    scan(path.join(process.env.HOME ?? '', 'Library', 'Java', 'JavaVirtualMachines'), 'JavaVirtualMachines')
  } else {
    scan('/usr/lib/jvm', '/usr/lib/jvm')
  }
  return [...found.values()]
}

/**
 * Probe PATH and every candidate at once. Answers `{ best, onPath, all }`: `all` newest first,
 * `onPath` what `java` by name resolves to (or a not-found result), and `best` the newest usable
 * Java anywhere - or null when there is none.
 */
export async function discover() {
  const onPath = await probe('java')
  const rest = await Promise.all(candidatePaths().map(async (c) => ({ ...c, ...(await probe(c.path)) })))
  const all = rest.filter((r) => r.found && r.major != null).sort((a, b) => b.major - a.major)
  if (onPath.found && onPath.major != null) all.unshift({ path: 'java', source: 'PATH', ...onPath })
  // Dedupe a PATH java that is also one of the folders scanned: same major and version string.
  const seen = new Set()
  const unique = all.filter((r) => {
    const key = r.version
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).sort((a, b) => b.major - a.major)
  const best = unique.find((r) => r.major >= MINIMUM_MAJOR) ?? null
  return { best, onPath, all: unique }
}

/**
 * The Java a new server should run on when nobody chose one.
 *
 * <p>`java` by name when PATH has the best one - the registry stays readable and follows an
 * upgrade. An absolute path when the best Java is one PATH cannot see, or PATH has an older one
 * than is installed elsewhere. Null when there is no usable Java at all; callers say so.
 */
export async function defaultJava() {
  const { best, onPath } = await discover()
  if (!best) return null
  if (onPath.found && onPath.major === best.major) return 'java'
  return best.path
}

/**
 * What the panel's banner, the wizard and `doctor` say about Java on this machine.
 *
 * <p>Shaped like probe()'s answer so the callers that read `ok`, `reason` and `message` keep
 * working, with the extra facts a person needs when PATH and reality disagree.
 */
export async function health() {
  const { best, onPath, all } = await discover()
  if (!best) {
    return {
      ...onPath,
      ok: false,
      found: all.length > 0,
      path: null,
      onPath: false,
      others: all,
      message: all.length
        ? `Java ${all[0].major} was found at ${all[0].path}, but a Minecraft server needs ${MINIMUM_MAJOR} or newer.`
        : 'Java is not installed, or is somewhere mcctl did not look.',
    }
  }
  const viaPath = best.path === 'java'
  const state = await probe(best.path)
  const where = viaPath ? '' : ` at ${best.path}`
  const note = viaPath ? '' : (onPath.found
    ? ` PATH points at Java ${onPath.major}; mcctl will use this one instead.`
    : ' It is not on PATH; mcctl will use it anyway.')
  return {
    ...state,
    path: best.path,
    onPath: viaPath,
    others: all,
    message: state.reason === 'ok'
      ? `Java ${state.major} is installed${where}.${note}`
      : `${state.message}${where ? ` Found${where}.` : ''}${note}`,
  }
}

/**
 * The Java a Minecraft version needs to run at all.
 *
 * <p>Mojang's own floor, which every server built on a version inherits - Paper, Purpur, Folia,
 * Spigot, Fabric and NeoForge all load the same class files. Held here rather than fetched so
 * the answer is the same offline, in the CLI and in the panel; vanilla's manifest carries the
 * same number and agrees with this table. Unknown shapes answer null, which means "no check":
 * a snapshot name or a fork's own numbering must not stop a person who knows what they are doing.
 *
 * <p>Too NEW is not checked. A modern Java runs an old server more often than not, and a refusal
 * there would be a guess; too old is a certainty, because the class files will not load.
 */
export function requiredMajor(mc) {
  // Digits and dots only: a snapshot like 25w14a is not a release and answers null.
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(mc ?? '').trim())
  if (!m) return null
  const a = Number(m[1])
  const b = m[2] == null ? 0 : Number(m[2])
  const c = m[3] == null ? 0 : Number(m[3])
  // Year-based versions, 26.1 onward, need 25.
  if (a >= 25) return 25
  if (a !== 1) return null
  if (b >= 21) return 21
  if (b === 20) return c >= 5 ? 21 : 17
  if (b >= 18) return 17
  if (b === 17) return 16
  return 8
}

/** The newest Java on this machine that satisfies a requirement, or null. */
export async function javaFor(needs) {
  const { all } = await discover()
  return all.find((j) => j.major >= needs) ?? null
}

/**
 * Decide which Java a server gets, before anything is downloaded or launched.
 *
 * <p>Someone who named a Java gets that Java - it is run to make sure it exists, and refused
 * only when it is certainly too old for the version and `force` was not given. Nobody naming
 * one gets the newest installed Java that satisfies the version, which is how a 1.20.4 test
 * server lands on 17 and the 26.x server beside it on 25 with no one choosing. When nothing
 * installed is new enough the refusal names what is needed, what was found and where to get
 * it; `force` goes ahead on the best there is, for the person who knows better.
 *
 * <p>A machine with no Java at all is not refused here: the panel's banner already says so,
 * and start says it again by name. Creating the folder costs nothing.
 */
export async function pickJava({ explicit = null, needs = null, force = false, what = 'this version' } = {}) {
  if (explicit) {
    const state = await probe(explicit)
    if (!state.found) fail(`${explicit} could not be run: ${state.message}`)
    if (needs && state.major != null && state.major < needs && !force) {
      throw tooOld(`${what} needs Java ${needs}, and ${explicit} is Java ${state.major}. `
        + 'Pick a newer Java, or pass --force to use it anyway.', { needs, have: state.major })
    }
    return explicit
  }
  if (!needs) return (await defaultJava()) ?? 'java'
  const fit = await javaFor(needs)
  if (fit) return fit.path === 'java' ? 'java' : fit.path
  const { best } = await discover()
  if (!best) return 'java'
  if (force) return best.path
  throw tooOld(`${what} needs Java ${needs}. The newest Java on this machine is ${best.major}`
    + `${best.path === 'java' ? '' : ` (${best.path})`}. Install Java ${needs} from ${DOWNLOAD_URL}, `
    + 'or create it anyway and point it at a Java of your own afterwards.', { needs, have: best.major })
}

/** A refusal the panel can recognise and offer to override. */
function tooOld(message, { needs, have }) {
  const err = new UserError(message)
  err.code = 'java-too-old'
  err.needs = needs
  err.have = have
  return err
}
