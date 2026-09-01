/**
 * Instance daemon. Spawned detached by `mcctl start`.
 *
 * Its whole reason to exist: a Minecraft server is an interactive foreground
 * process. Running it directly from a CLI call means the call blocks forever,
 * stdin is unreachable, and console output is lost. The daemon owns the java
 * child, mirrors its output into a log file, and exposes a control socket so
 * short-lived CLI invocations can inject console lines and request shutdown.
 *
 * It also owns crash recovery, because it is the only thing alive at the
 * moment a server dies. With auto-restart on, a crash is relaunched in place
 * after a short delay; the rules live in crashguard.mjs.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { getInstance, serverJarPath, jvmFlagsFor } from './registry.mjs'
import { runDir, stateFile, consoleLog, daemonLog, controlPath } from './paths.mjs'
import { writeJson } from './util.mjs'
import { startSampler, metricsFile } from './metrics.mjs'
import { crashVerdict, CRASH_LIMIT, CRASH_WINDOW_MS } from './crashguard.mjs'
import { notifyInstance } from './notify.mjs'
import { diagnose } from './diagnose.mjs'

const name = process.argv[2]
if (!name) {
  process.stderr.write('daemon: missing instance name\n')
  process.exit(2)
}

const dir = runDir(name)
fs.mkdirSync(dir, { recursive: true })

const diag = fs.createWriteStream(daemonLog(name), { flags: 'a' })
function log(msg) {
  diag.write(`[${new Date().toISOString()}] ${msg}\n`)
}

/**
 * Die legibly.
 *
 * <p>Everything below runs while this module is still being evaluated, and a throw there produced
 * absolutely nothing: no state file, no daemon.log - the write stream above has not finished
 * opening yet - and no stderr, because this process is spawned detached with stdio ignored. All
 * the caller could report was that the daemon "never came up", which is true and useless. One bad
 * memory value in the registry was enough to reach it.
 *
 * <p>So the reason is written SYNCHRONOUSLY, to both places the caller looks: appendFileSync lands
 * even when the process is about to exit, and the state file is what `start` is already polling.
 */
function die(err) {
  const reason = err?.message ?? String(err)
  try {
    fs.appendFileSync(daemonLog(name), `[${new Date().toISOString()}] failed to start: ${reason}\n`)
  } catch {
    /* nothing left to try */
  }
  try {
    writeJson(stateFile(name), {
      name,
      daemonPid: process.pid,
      running: false,
      error: reason,
      failedAt: Date.now(),
    })
  } catch {
    /* nothing left to try */
  }
  process.exit(1)
}

process.on('uncaughtException', die)

// One console file per daemon, truncated once at the first start so `logs` shows this session
// only. A crash-restart APPENDS to the same file - the lines before the crash are the reason
// it crashed, and they must survive the recovery.
const out = fs.createWriteStream(consoleLog(name), { flags: 'w' })

// ---- one run of the server --------------------------------------------------

let child = null
let inst = null
let state = null
let stopping = false
let stopSent = false
let respawnTimer = null
let stopSampler = () => {}
let recent = ''
const stopWaiters = []
const crashes = []

// The last webhook in flight, so shutdown can give it a moment to land instead of exiting
// underneath it. Capped - a dead webhook must not hold a dead server's daemon open.
let lastNotify = Promise.resolve()
function tell(message) {
  lastNotify = notifyInstance(inst, message, { log })
}

/** Marks the point where Paper has finished loading and is accepting joins. */
const READY_RE = /Done \([\d.,]+s\)!/

function launch({ first }) {
  // Re-read the registry on every launch, not just the first: memory edits, an auto-restart
  // toggle or a new webhook should apply at the next respawn without a manual cycle.
  inst = getInstance(name)
  const jar = serverJarPath(inst)
  const flags = inst.jvmFlags?.length ? inst.jvmFlags : jvmFlagsFor(inst.memory)
  const args = [`-Xms${inst.memory}`, `-Xmx${inst.memory}`, ...flags, '-jar', path.basename(jar), '--nogui']

  log(`starting ${inst.java || 'java'} ${args.join(' ')} (cwd=${inst.dir})${first ? '' : ' [auto-restart]'}`)

  child = spawn(inst.java || 'java', args, {
    cwd: inst.dir,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  child.stdout.pipe(out, { end: false })
  child.stderr.pipe(out, { end: false })

  // A ring of the child's last output, kept so the moment it dies the daemon can say WHY -
  // the child is gone by then, and the daemon is the only thing still holding its last words.
  recent = ''
  const remember = (chunk) => {
    recent = (recent + chunk.toString()).slice(-32768)
  }
  child.stdout.on('data', remember)
  child.stderr.on('data', remember)

  // Watch this run's output until the server reports ready, so a recovery can say "back up"
  // rather than merely "trying". Only recoveries notify - a person starting their own server
  // does not need a message saying they did.
  if (!first) {
    let tail = ''
    let seen = false
    const watch = (chunk) => {
      if (seen) return
      tail = (tail + chunk.toString('utf8')).slice(-4096)
      if (READY_RE.test(tail)) {
        seen = true
        child.stdout.removeListener('data', watch)
        log('recovered: server reports ready')
        tell(`back up after a crash — restart ${crashes.length} of ${CRASH_LIMIT} allowed per ${CRASH_WINDOW_MS / 60000} minutes.`)
      }
    }
    child.stdout.on('data', watch)
  }

  state = {
    name,
    daemonPid: process.pid,
    javaPid: child.pid,
    startedAt: Date.now(),
    dir: inst.dir,
    jar: inst.jar,
    memory: inst.memory,
    port: inst.port,
    rconPort: inst.rcon?.port ?? null,
    control: controlPath(name),
    running: true,
    restarts: crashes.length,
  }
  writeJson(stateFile(name), state)
  log(`java pid ${child.pid}`)

  // Performance history starts empty every run. The old file describes a process that no longer
  // exists, and a graph that silently splices two runs together is worse than one that starts blank.
  try {
    fs.rmSync(metricsFile(name), { force: true })
  } catch {
    /* a leftover file only costs a stale first sample */
  }
  // A graph is worth less than the thing it graphs, so a sampler that cannot start says so in the
  // daemon log and the server carries on without one.
  stopSampler = startSampler(name, child.pid, {
    onError: (err) => log(`performance sampling unavailable: ${err.message}`),
  })

  child.on('exit', (code, signal) => onExit(code, signal))

  child.on('error', (err) => {
    log(`spawn error: ${err.message}`)
    out.write(`\n[mcctl] failed to launch server: ${err.message}\n`)
    state.running = false
    state.error = err.message
    writeJson(stateFile(name), state)
    setTimeout(() => process.exit(1), 250)
  })
}

/** Write the final state and let the daemon end. The one exit path for a server staying down. */
function shutDown(code, signal, error) {
  state.running = false
  delete state.restarting
  state.exitCode = code
  state.exitSignal = signal
  state.stoppedAt = Date.now()
  if (error) state.error = error
  writeJson(stateFile(name), state)
  for (const resolve of stopWaiters) resolve(code)
  try {
    server.close()
  } catch {
    /* already closed */
  }
  // Give the log stream - and a webhook in flight - a moment to land before the process goes
  // away, without letting either hold it open.
  const grace = new Promise((r) => setTimeout(r, 4000))
  Promise.race([lastNotify, grace]).finally(() => setTimeout(() => process.exit(0), 250))
}

function onExit(code, signal) {
  log(`java exited code=${code} signal=${signal}`)
  stopSampler()
  out.write(`\n[mcctl] server process exited (code=${code}${signal ? `, signal=${signal}` : ''})\n`)

  const crashed = (code !== 0 && code !== null) || Boolean(signal)
  if (crashed && !stopping) crashes.push(Date.now())

  // Name the likely cause while the evidence is at hand. One finding, in the console and on
  // the webhook - a person woken by "crashed" should not have to open a log to learn "out of
  // memory" when the daemon already knows.
  let cause = ''
  if (crashed && !stopping) {
    const finding = diagnose(recent.split(/\r?\n/), { port: inst.port, memory: inst.memory, dir: inst.dir })[0]
    if (finding) {
      cause = ` Likely cause: ${finding.title.toLowerCase()}.`
      out.write(`[mcctl] likely cause: ${finding.title} — ${finding.advice}\n`)
    }
  }

  // Freshly read, so flipping auto-restart off in the panel counts from the very next exit
  // rather than from the next manual start.
  let enabled = Boolean(inst.autoRestart)
  try {
    inst = getInstance(name)
    enabled = Boolean(inst.autoRestart)
  } catch {
    /* the registry answered at launch; keep what it said then */
  }

  const verdict = crashVerdict({ enabled, stopping, code, signal, crashes })

  if (verdict.kind === 'restart') {
    const wait = Math.round(verdict.delayMs / 1000)
    out.write(`[mcctl] crash ${verdict.recent} of ${CRASH_LIMIT} allowed per ${CRASH_WINDOW_MS / 60000} minutes — restarting in ${wait}s\n`)
    tell(`crashed (exit ${signal || code}).${cause} Restarting in ${wait}s.`)
    // The state keeps running:true while the timer runs, so readState reports "stopping" rather
    // than "stopped" - a start racing into this window would collide with the respawn.
    state.restarting = true
    writeJson(stateFile(name), state)
    respawnTimer = setTimeout(() => {
      respawnTimer = null
      if (stopping) return shutDown(code, signal)
      try {
        launch({ first: false })
      } catch (err) {
        log(`auto-restart failed: ${err.message}`)
        out.write(`\n[mcctl] auto-restart failed: ${err.message}\n`)
        tell(`auto-restart failed: ${err.message}`)
        shutDown(code, signal, `auto-restart failed: ${err.message}`)
      }
    }, verdict.delayMs)
    return
  }

  if (verdict.kind === 'give-up') {
    const why = `crashed ${verdict.recent} times in ${CRASH_WINDOW_MS / 60000} minutes; auto-restart gave up`
    out.write(`[mcctl] ${why}. See the lines above for the reason it keeps dying.\n`)
    tell(`${why}. It is staying down until someone looks at it.`)
    return shutDown(code, signal, why)
  }

  // Staying down. A crash with auto-restart off is still worth a message - it is the one case
  // where the server is dead and nothing is going to do anything about it.
  if (crashed && !stopping) {
    tell(`crashed (exit ${signal || code}) and is staying down — auto-restart is off.${cause}`)
  }
  shutDown(code, signal)
}

try {
  launch({ first: true })
} catch (err) {
  die(err)
}

function forceKill() {
  if (!child || child.exitCode !== null) return
  log('force killing')
  if (process.platform === 'win32') {
    // Kill the whole tree - the JVM may have spawned helpers.
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else {
    try {
      process.kill(child.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

function waitForExit(timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(child?.exitCode ?? null)
  return new Promise((resolve) => {
    stopWaiters.push(resolve)
    if (timeoutMs > 0) setTimeout(() => resolve(null), timeoutMs)
  })
}

async function handleStop(timeoutMs) {
  stopping = true
  // A stop that lands during the respawn delay cancels the respawn - the person asked for a
  // stopped server, and "stopped" must not mean "back in ten seconds".
  if (respawnTimer) {
    clearTimeout(respawnTimer)
    respawnTimer = null
    log('stop received during restart delay; staying down')
    shutDown(state.exitCode ?? null, state.exitSignal ?? null)
    return { ok: true, code: state.exitCode ?? null, already: true }
  }
  if (child.exitCode !== null) return { ok: true, code: child.exitCode, already: true }
  if (!stopSent) {
    stopSent = true
    log('sending stop to console')
    try {
      child.stdin.write('stop\n')
    } catch (err) {
      log(`stdin write failed: ${err.message}`)
    }
  }
  const code = await waitForExit(timeoutMs)
  if (code === null) {
    log('graceful stop timed out')
    forceKill()
    await waitForExit(10000)
    return { ok: true, forced: true, code: child.exitCode }
  }
  return { ok: true, code }
}

// --- control socket ---------------------------------------------------------

const controlAddr = controlPath(name)
if (process.platform !== 'win32') {
  try {
    fs.unlinkSync(controlAddr)
  } catch {
    /* no stale socket */
  }
}

const server = net.createServer((socket) => {
  let buf = ''
  socket.on('data', async (chunk) => {
    buf += chunk.toString('utf8')
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      let req
      try {
        req = JSON.parse(line)
      } catch {
        socket.write(`${JSON.stringify({ ok: false, error: 'malformed request' })}\n`)
        continue
      }
      let res
      try {
        res = await handle(req)
      } catch (err) {
        res = { ok: false, error: err.message }
      }
      socket.write(`${JSON.stringify(res)}\n`)
    }
  })
  socket.on('error', () => socket.destroy())
})

async function handle(req) {
  switch (req.op) {
    case 'ping':
      return { ok: true, javaPid: child?.pid ?? null, startedAt: state.startedAt, alive: Boolean(child) && child.exitCode === null }
    case 'send':
      if (!child || child.exitCode !== null) return { ok: false, error: 'server process is not running' }
      if (typeof req.line !== 'string') return { ok: false, error: 'send requires a line' }
      child.stdin.write(`${req.line.replace(/\r?\n$/, '')}\n`)
      log(`console <- ${req.line}`)
      return { ok: true }
    case 'stop':
      return handleStop(Number(req.timeout) > 0 ? Number(req.timeout) : 90000)
    case 'kill':
      stopping = true
      if (respawnTimer) {
        clearTimeout(respawnTimer)
        respawnTimer = null
        shutDown(state.exitCode ?? null, state.exitSignal ?? null)
        return { ok: true, code: state.exitCode ?? null, forced: true }
      }
      forceKill()
      await waitForExit(10000)
      return { ok: true, code: child?.exitCode ?? null, forced: true }
    default:
      return { ok: false, error: `unknown op "${req.op}"` }
  }
}

/**
 * Bind the control channel, retrying while a previous daemon for this instance
 * still holds the pipe. A restart can spawn us milliseconds after the outgoing
 * daemon's java child exited but before that daemon has released the name.
 *
 * If the channel can never be bound, the server would run unmanageable - no
 * stdin, no graceful stop. That is worse than not running, so we refuse to
 * stay up rather than silently logging the failure.
 */
const LISTEN_RETRY_MS = 250
const LISTEN_TIMEOUT_MS = 15000

function listenWithRetry(deadline = Date.now() + LISTEN_TIMEOUT_MS) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && Date.now() < deadline) {
      log(`control socket busy at ${controlAddr}, retrying`)
      setTimeout(() => listenWithRetry(deadline), LISTEN_RETRY_MS)
      return
    }
    log(`control socket fatal: ${err.message}`)
    out.write(`\n[mcctl] control channel unavailable (${err.message}); stopping the server\n`)
    state.running = false
    state.error = `control channel unavailable: ${err.message}`
    writeJson(stateFile(name), state)
    forceKill()
    setTimeout(() => process.exit(1), 1000)
  })
  server.listen(controlAddr, () => log(`control socket listening on ${controlAddr}`))
}

listenWithRetry()

// Keep the daemon alive even if the terminal that spawned it goes away.
process.on('SIGINT', () => {})
process.on('SIGTERM', () => {
  handleStop(90000).then(() => process.exit(0))
})
