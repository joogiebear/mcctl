/**
 * Instance daemon. Spawned detached by `mcctl start`.
 *
 * Its whole reason to exist: a Minecraft server is an interactive foreground
 * process. Running it directly from a CLI call means the call blocks forever,
 * stdin is unreachable, and console output is lost. The daemon owns the java
 * child, mirrors its output into a log file, and exposes a control socket so
 * short-lived CLI invocations can inject console lines and request shutdown.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { getInstance, serverJarPath, jvmFlagsFor } from './registry.mjs'
import { runDir, stateFile, consoleLog, daemonLog, controlPath } from './paths.mjs'
import { writeJson } from './util.mjs'

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

let inst
let jar
let args
try {
  inst = getInstance(name)
  jar = serverJarPath(inst)
  const flags = inst.jvmFlags?.length ? inst.jvmFlags : jvmFlagsFor(inst.memory)
  args = [`-Xms${inst.memory}`, `-Xmx${inst.memory}`, ...flags, '-jar', path.basename(jar), '--nogui']
} catch (err) {
  die(err)
}

// Truncate the captured console on each start so `logs` shows this run only.
// The server's own logs/ directory keeps the full rolling history.
const out = fs.createWriteStream(consoleLog(name), { flags: 'w' })

log(`starting ${inst.java || 'java'} ${args.join(' ')} (cwd=${inst.dir})`)

const child = spawn(inst.java || 'java', args, {
  cwd: inst.dir,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})

child.stdout.pipe(out, { end: false })
child.stderr.pipe(out, { end: false })

const state = {
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
}
writeJson(stateFile(name), state)
log(`java pid ${child.pid}`)

let stopping = false
const stopWaiters = []

child.on('exit', (code, signal) => {
  log(`java exited code=${code} signal=${signal}`)
  out.write(`\n[mcctl] server process exited (code=${code}${signal ? `, signal=${signal}` : ''})\n`)
  state.running = false
  state.exitCode = code
  state.exitSignal = signal
  state.stoppedAt = Date.now()
  writeJson(stateFile(name), state)
  for (const resolve of stopWaiters) resolve(code)
  try {
    server.close()
  } catch {
    /* already closed */
  }
  // Give the log stream a moment to flush before the process goes away.
  setTimeout(() => process.exit(0), 250)
})

child.on('error', (err) => {
  log(`spawn error: ${err.message}`)
  out.write(`\n[mcctl] failed to launch server: ${err.message}\n`)
  state.running = false
  state.error = err.message
  writeJson(stateFile(name), state)
  setTimeout(() => process.exit(1), 250)
})

function forceKill() {
  if (child.exitCode !== null) return
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
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolve) => {
    stopWaiters.push(resolve)
    if (timeoutMs > 0) setTimeout(() => resolve(null), timeoutMs)
  })
}

async function handleStop(timeoutMs) {
  if (child.exitCode !== null) return { ok: true, code: child.exitCode, already: true }
  if (!stopping) {
    stopping = true
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
      return { ok: true, javaPid: child.pid, startedAt: state.startedAt, alive: child.exitCode === null }
    case 'send':
      if (child.exitCode !== null) return { ok: false, error: 'server process is not running' }
      if (typeof req.line !== 'string') return { ok: false, error: 'send requires a line' }
      child.stdin.write(`${req.line.replace(/\r?\n$/, '')}\n`)
      log(`console <- ${req.line}`)
      return { ok: true }
    case 'stop':
      return handleStop(Number(req.timeout) > 0 ? Number(req.timeout) : 90000)
    case 'kill':
      forceKill()
      await waitForExit(10000)
      return { ok: true, code: child.exitCode, forced: true }
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
