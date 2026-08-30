import http from 'node:http'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as supervisor from './supervisor.mjs'
import * as registry from './registry.mjs'
import * as create from './create.mjs'
import * as paper from './paper.mjs'
import * as manage from './manage.mjs'
import { LAYOUT } from './paths.mjs'
import * as java from './java.mjs'
import * as backup from './backup.mjs'
import * as schedule from './schedule.mjs'
import { readProps, writeProps } from './props.mjs'
import { storedPlayers } from './players.mjs'
import * as settings from './settings.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * A local control panel for mcctl.
 *
 * <p>Bound to 127.0.0.1 and nothing else. This exposes start/stop and console input, which is
 * remote code execution by another name — it is a convenience for the person at this keyboard, not
 * a service. Binding it to a LAN address would put an unauthenticated server console on the network.
 *
 * <p>Served from Node's own http module with the page as one embedded file: no framework, no build
 * step, and no dependency that can rot between the day this is written and the day it is needed.
 */
export function serve({ port = 8770, host = '127.0.0.1', open = true } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      if (!isLocalRequest(req)) {
        return json(res, 403, { error: 'this panel only answers requests addressed to localhost' })
      }
      await route(req, res)
    } catch (err) {
      json(res, 500, { error: err?.message ?? String(err) })
    }
  })

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      // Report the port actually bound, not the one asked for: the desktop app passes 0 so the OS
      // picks a free one, and a URL built from the request would point at port zero.
      const bound = server.address().port
      const url = `http://${host}:${bound}/`
      if (open) openBrowser(url)
      resolve({ server, url, port: bound })
    })
  })
}

/**
 * Progress for long-running creates.
 *
 * <p>Creating an instance downloads a ~50MB server jar. That is the slowest thing a new user does
 * and the one place where silence reads as a hang, so the create call reports where it has got to
 * and the page streams it. Kept in memory and keyed by an id the caller supplies: a job is only
 * interesting while the page that started it is still open, and a restart losing them is correct.
 */
const jobs = new Map()
const JOB_LIMIT = 32

function jobUpdate(id, patch) {
  if (!id) return
  const job = jobs.get(id) ?? { id, stage: 'start', percent: null, message: '', done: false }
  Object.assign(job, patch)
  jobs.set(id, job)
  for (const send of job.listeners ?? []) send(job)
  // Oldest first: Map preserves insertion order, so this drops the job least likely to be watched.
  while (jobs.size > JOB_LIMIT) jobs.delete(jobs.keys().next().value)
}

/**
 * The server.properties keys the panel offers.
 *
 * <p>An allowlist, for two reasons. server.properties has around fifty keys and a panel that showed
 * all of them would be a worse text editor than the file already is - `mcctl props` exists for the
 * rest. And several keys are owned by mcctl rather than by the person: the ports and the RCON
 * password come from the registry and syncProps rewrites them on every launch, so letting the page
 * set them would produce a value that silently reverts.
 *
 * <p>`type` is what the page renders. `note` is shown next to the control when the choice has a
 * consequence worth knowing before making it.
 */
const EDITABLE_PROPS = [
  {
    key: 'online-mode',
    label: 'Require a Minecraft account',
    type: 'bool',
    fallback: 'true',
    note: 'Off lets anyone join as any name, which is what multi-account testing needs - but it '
      + 'gives players name-derived UUIDs instead of real ones, and puts an OFFLINE/INSECURE '
      + 'banner in every log. Plugin authors often refuse a bug report carrying it.',
  },
  { key: 'motd', label: 'Message of the day', type: 'text', fallback: 'A Minecraft Server' },
  { key: 'difficulty', label: 'Difficulty', type: 'enum', fallback: 'easy', options: ['peaceful', 'easy', 'normal', 'hard'] },
  { key: 'gamemode', label: 'Default game mode', type: 'enum', fallback: 'survival', options: ['survival', 'creative', 'adventure', 'spectator'] },
  { key: 'max-players', label: 'Max players', type: 'int', fallback: '20', min: 1, max: 1000 },
  { key: 'pvp', label: 'PvP', type: 'bool', fallback: 'true' },
  { key: 'white-list', label: 'Whitelist', type: 'bool', fallback: 'false', note: 'Only listed players can join. Add them from the console with "whitelist add <name>".' },
  { key: 'view-distance', label: 'View distance', type: 'int', fallback: '10', min: 2, max: 32 },
  { key: 'spawn-protection', label: 'Spawn protection', type: 'int', fallback: '16', min: 0, max: 256 },
]

const PROP_BY_KEY = new Map(EDITABLE_PROPS.map((p) => [p.key, p]))

/** Reject a value the server would reject, before it reaches the file. */
function coerceProp(spec, raw) {
  const value = String(raw).trim()
  if (spec.type === 'bool') {
    if (value !== 'true' && value !== 'false') fail(`${spec.key} must be true or false`)
    return value
  }
  if (spec.type === 'enum') {
    if (!spec.options.includes(value)) fail(`${spec.key} must be one of: ${spec.options.join(', ')}`)
    return value
  }
  if (spec.type === 'int') {
    const n = Number(value)
    if (!Number.isInteger(n) || n < spec.min || n > spec.max) {
      fail(`${spec.key} must be a whole number from ${spec.min} to ${spec.max}`)
    }
    return String(n)
  }
  // Text. A newline would split the line and silently create a second key.
  if (/[\r\n]/.test(value)) fail(`${spec.key} cannot contain a line break`)
  return value
}

function fail(message) {
  const err = new Error(message)
  err.userFacing = true
  throw err
}

/**
 * Read or update the properties the panel offers.
 *
 * <p>Writes go through writeProps, which rewrites only the keys it is handed and leaves every other
 * line - and every comment - where it was. The server reads this file once at boot, so a change
 * made while it is running takes effect on the next start, and the response says so rather than
 * leaving someone to wonder why nothing happened.
 */
async function handleProps(req, res, name) {
  const inst = registry.getInstance(name)
  const file = path.join(inst.dir, 'server.properties')
  // A server that has never booted has only the keys mcctl wrote; Paper fills the rest in on its
  // first start. Showing those as blank would be wrong - the server has a value for them, it just
  // has not written it down yet - so the effective default is shown, flagged as not-yet-set.
  const shape = (current) => EDITABLE_PROPS.map((spec) => ({
    ...spec,
    value: current.get(spec.key) ?? spec.fallback,
    set: current.has(spec.key),
  }))

  if (req.method === 'GET') {
    // Who the world already knows about, so the page can warn before online mode is changed under
    // them. Switching does not migrate anyone - it hands everybody a different identity.
    return json(res, 200, { fields: shape(readProps(file)), file, players: storedPlayers(inst.dir) })
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

  const body = await readBody(req)
  const updates = {}
  for (const [key, raw] of Object.entries(body)) {
    const spec = PROP_BY_KEY.get(key)
    if (!spec) return json(res, 400, { error: `${key} is not editable from here` })
    updates[key] = coerceProp(spec, raw)
  }
  if (!Object.keys(updates).length) return json(res, 400, { error: 'nothing to change' })

  writeProps(file, updates)
  return json(res, 200, {
    changed: Object.keys(updates),
    appliesOnRestart: supervisor.isRunning(name),
    fields: shape(readProps(file)),
  })
}

/**
 * Snapshots: what exists, making one, restoring one, throwing one away.
 *
 * <p>Restore is the dangerous one - it extracts over a live server's files while the server holds
 * them open and its own state in memory, which corrupts a world rather than replacing it. The CLI
 * has always refused on a running server; this refuses for the same reason rather than trusting the
 * page to have disabled a button.
 */
async function handleBackups(req, res, name, seg) {
  const inst = registry.getInstance(name)
  const action = seg[4] ?? null

  if (req.method === 'GET') {
    const auto = schedule.list().find((t) => t.instance === name && t.action.type === 'backup') ?? null
    return json(res, 200, {
      snapshots: backup.listSnapshots(name),
      dir: path.join(LAYOUT.backupsDir, name),
      root: LAYOUT.backupsDir,
      scopes: backup.SCOPES,
      running: supervisor.isRunning(name),
      auto: auto && {
        id: auto.id,
        enabled: auto.enabled,
        schedule: auto.schedule,
        keep: auto.action.keep ?? null,
        state: auto.windows?.state ?? null,
        lastResult: auto.windows ? schedule.describeResult(auto.windows.lastResult) : null,
        nextRun: auto.windows?.nextRun ?? null,
      },
    })
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

  const body = await readBody(req)

  if (!action) {
    // A snapshot of a running server is legitimate - it is what "back up before I try this" means -
    // and createSnapshot excludes the one file the server holds locked.
    const running = supervisor.isRunning(name)
    const out = await backup.createSnapshot(inst, {
      scope: backup.SCOPES.includes(body.scope) ? body.scope : 'standard',
      label: body.label ? String(body.label).slice(0, 40) : 'manual',
      running,
    })
    return json(res, 200, { created: path.basename(out.file), size: out.size, members: out.members })
  }

  if (action === 'restore') {
    if (!body.snapshot) return json(res, 400, { error: 'which snapshot?' })
    if (supervisor.isRunning(name)) {
      return json(res, 409, {
        error: `"${name}" is running. Stop it before restoring - extracting over a server that has `
          + 'those files open corrupts a world rather than replacing it.',
      })
    }
    const snap = backup.resolveSnapshot(name, String(body.snapshot))
    const out = await backup.restoreSnapshot(inst, snap)
    return json(res, 200, out)
  }

  if (action === 'delete') {
    if (!body.snapshot) return json(res, 400, { error: 'which snapshot?' })
    return json(res, 200, backup.removeSnapshot(name, String(body.snapshot)))
  }

  if (action === 'auto') {
    const existing = schedule.list().find((t) => t.instance === name && t.action.type === 'backup')
    if (body.enabled === false) {
      if (existing) schedule.remove(existing.id)
      return json(res, 200, { auto: null })
    }
    // One automatic backup per server. A second would race the first for the same tar and prune
    // each other's output; if someone wants two rhythms they can add a task in the scheduler.
    if (existing) schedule.remove(existing.id)
    const keep = Number(body.keep)
    const made = schedule.create({
      instance: name,
      name: 'Automatic backup',
      action: { type: 'backup', keep: Number.isInteger(keep) && keep > 0 ? keep : null },
      schedule: body.schedule ?? { kind: 'daily', at: '03:00' },
    })
    return json(res, 200, { auto: { id: made.id, schedule: made.schedule, keep: made.action.keep } })
  }

  return json(res, 404, { error: 'not found' })
}

/**
 * Scheduled tasks for one server.
 *
 * <p>Scoped to an instance rather than global, and every id is checked to belong to the instance in
 * the URL. Without that check the instance name would be decoration: any name plus another server's
 * task id would delete that server's backup schedule.
 */
async function handleSchedules(req, res, name, seg) {
  registry.getInstance(name)
  const id = seg[4] ?? null
  const verb = seg[5] ?? null

  const mine = () => schedule.list().filter((t) => t.instance === name)

  const shape = (t) => ({
    id: t.id,
    name: t.name,
    action: t.action,
    schedule: t.schedule,
    enabled: t.enabled,
    owner: t.owner ?? null,
    createdAt: t.createdAt,
    // Windows is the authority on whether this actually exists and when it last ran. A task mcctl
    // believes in that the scheduler has never heard of reports known:false rather than as working.
    known: Boolean(t.windows),
    state: t.windows?.state ?? null,
    lastRun: t.windows?.lastRun ?? null,
    lastResult: t.windows ? schedule.describeResult(t.windows.lastResult) : null,
    nextRun: t.windows?.nextRun ?? null,
  })

  if (req.method === 'GET') {
    return json(res, 200, {
      tasks: mine().map(shape),
      runs: schedule.recentRuns(name),
      actions: Object.entries(schedule.ACTIONS).map(([type, meta]) => ({
        type, label: meta.label, needsRunning: meta.needsRunning,
      })),
      kinds: schedule.SCHEDULE_KINDS,
      days: schedule.DAYS,
      running: supervisor.isRunning(name),
    })
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

  const body = await readBody(req)

  if (!id) {
    const made = schedule.create({
      instance: name,
      name: body.name,
      action: body.action,
      schedule: body.schedule,
      enabled: body.enabled !== false,
    })
    return json(res, 200, shape({ ...made, windows: null }))
  }

  // Every id-addressed route below acts on a task, so the ownership check happens once, here.
  const owned = mine().find((t) => t.id === id)
  if (!owned) return json(res, 404, { error: `"${name}" has no scheduled task "${id}"` })

  if (!verb) {
    schedule.update(id, {
      name: body.name,
      action: body.action,
      schedule: body.schedule,
      enabled: body.enabled,
    })
    return json(res, 200, shape(mine().find((t) => t.id === id)))
  }

  if (verb === 'enable') {
    schedule.setEnabled(id, body.enabled !== false)
    return json(res, 200, shape(mine().find((t) => t.id === id)))
  }

  if (verb === 'run') {
    schedule.runNow(id)
    // Fired, not finished: schtasks /Run returns as soon as Windows has started the task. What it
    // did shows up in the run log a moment later, which is what the panel re-reads.
    return json(res, 200, { started: true })
  }

  if (verb === 'delete') {
    return json(res, 200, schedule.remove(id))
  }

  return json(res, 404, { error: 'not found' })
}

/**
 * An instance as the page is allowed to see it.
 *
 * <p>The RCON password is a credential. The page has never needed it, but only the list route was
 * stripping it - every start, stop, restart and settings response was handing it back, where it
 * lands in a browser cache, a screenshot, or a pasted bug report.
 */
function safeInstance(row) {
  const { rcon, ...safe } = row
  // Whether anyone can join as any name is a property of the server, not of the registry, so it is
  // read from the file. The panel badges it: an offline server behaves differently for any plugin
  // that keys data by UUID, and its logs get bug reports refused.
  let onlineMode = null
  try {
    onlineMode = readProps(path.join(row.dir, 'server.properties')).get('online-mode') !== 'false'
  } catch {
    /* a directory that has gone missing is already reported through status */
  }
  return { ...safe, rconPort: rcon?.port ?? null, onlineMode }
}

/**
 * Whether this request was actually addressed to the loopback panel.
 *
 * <p>Binding to 127.0.0.1 stops other machines connecting; it does not stop the browser already on
 * this machine. Any web page can point a script at http://127.0.0.1:8770, and DNS rebinding lets a
 * page reach it under its own origin. This endpoint can start processes and type into a server
 * console, so "local" has to mean local, not merely reachable.
 *
 * <p>Two checks, both cheap: the Host header must name a loopback address, which defeats rebinding
 * (the attacker's own hostname is what arrives); and an Origin, when there is one, must match that
 * Host exactly - port included. Requests with no Origin - the panel's own fetches, curl, the CLI -
 * are allowed through, because that is what a first-party request looks like.
 *
 * <p>The port is the half that matters here and was missing. Comparing only the hostname made
 * every page on loopback first-party, and this machine is full of them: dynmap, BlueMap, Plan and
 * friends all serve web UIs on their own loopback ports, all of them rendering names and chat that
 * players chose. One stored-content injection in a map plugin was enough to reach an endpoint that
 * can type into a server console.
 */
const LOOPBACK_HOST = /^(?:127\.\d+\.\d+\.\d+|\[::1\]|localhost)(?::\d+)?$/i

function isLocalRequest(req) {
  const host = req.headers.host
  if (!host || !LOOPBACK_HOST.test(host)) return false
  const origin = req.headers.origin
  if (!origin) return true
  try {
    // Exact match against our own Host, not merely "also on loopback".
    return new URL(origin).host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

function json(res, code, body) {
  const payload = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(payload)
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const seg = url.pathname.split('/').filter(Boolean)

  if (url.pathname === '/') {
    const html = readFileSync(path.join(HERE, 'ui.html'), 'utf8')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
    return
  }

  if (seg[0] !== 'api') return json(res, 404, { error: 'not found' })

  if (seg[1] === 'jars' && req.method === 'GET') {
    return json(res, 200, create.listJars().map((j) => ({ name: j.name, size: j.sizeHuman })))
  }

  // ---- prerequisites ---------------------------------------------------------
  // Java is the one thing mcctl needs and cannot provide. Asked here so the panel can say so up
  // front instead of letting it surface as "spawn java ENOENT" after a fifty-megabyte download.
  if (seg[1] === 'health' && req.method === 'GET') {
    return json(res, 200, { java: java.probe(), javaDownload: java.DOWNLOAD_URL })
  }

  // ---- where everything lives, for the settings screen ----------------------
  // The data root itself stays read-only here: it is resolved at import, and a process that
  // created an instance in one directory and looked for it in another would be worse than a
  // restart. backupsDir is settable because nothing holds a snapshot open across the change - but
  // it still only takes effect on restart, and the response says so rather than implying otherwise.
  if (seg[1] === 'settings' && req.method === 'POST') {
    const body = await readBody(req)
    if (!Object.hasOwn(body, 'backupsDir')) {
      return json(res, 400, { error: 'only backupsDir can be set from here' })
    }
    const raw = String(body.backupsDir ?? '').trim()
    if (!raw) {
      const fallback = path.join(LAYOUT.dataRoot, 'backups')
      settings.save({ backupsDir: null })
      return json(res, 200, { backupsDir: fallback, restartRequired: fallback !== LAYOUT.backupsDir })
    }
    const dir = path.resolve(raw)
    const writable = settings.checkWritable(dir)
    if (!writable.ok) return json(res, 400, { error: `mcctl cannot write to ${dir}: ${writable.error}` })
    settings.save({ backupsDir: dir })
    return json(res, 200, { backupsDir: dir, restartRequired: dir !== LAYOUT.backupsDir })
  }

  if (seg[1] === 'settings' && req.method === 'GET') {
    return json(res, 200, {
      dataRoot: LAYOUT.dataRoot,
      instancesDir: LAYOUT.instancesDir,
      separateInstances: LAYOUT.separateInstances,
      jarsDir: LAYOUT.jarsDir,
      backupsDir: LAYOUT.backupsDir,
      templatesDir: LAYOUT.templatesDir,
      runDir: LAYOUT.runDir,
      settingsFile: LAYOUT.settingsFile,
      usingLegacyLayout: LAYOUT.usingLegacyLayout,
      platform: process.platform,
    })
  }

  // ---- progress for a create in flight -------------------------------------
  if (seg[1] === 'jobs' && seg[3] === 'stream' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const id = seg[2]
    const send = (job) => res.write(`data: ${JSON.stringify(job)}\n\n`)
    const job = jobs.get(id) ?? { id, stage: 'start', percent: null, message: '', done: false }
    // Replay first: the page opens this stream immediately after firing the POST, and the two
    // race. Whatever has already happened is sent before anything new is.
    const { listeners: _drop, ...snapshot } = job
    send(snapshot)
    job.listeners = job.listeners ?? []
    job.listeners.push(send)
    jobs.set(id, job)
    const beat = setInterval(() => res.write(': ping\n\n'), 20000)
    req.on('close', () => {
      clearInterval(beat)
      const live = jobs.get(id)
      if (live?.listeners) live.listeners = live.listeners.filter((fn) => fn !== send)
    })
    return
  }

  // ---- paper versions, for the create form's dropdown -----------------------
  if (seg[1] === 'paper' && seg[2] === 'versions' && req.method === 'GET') {
    return json(res, 200, await paper.versions())
  }

  // ---- instances -----------------------------------------------------------
  if (seg[1] === 'instances' && seg.length === 2 && req.method === 'GET') {
    const rows = registry.listInstances().map((i) => {
      let row
      try {
        row = supervisor.statusOf(i.name)
      } catch {
        row = { ...i, status: 'unknown' }
      }
      // The page never needs the RCON password, so it never receives it. Local-only or not,
      // a credential that is not sent cannot be read out of a browser cache or a screenshot.
      return safeInstance(row)
    })
    return json(res, 200, rows)
  }

  // ---- adopt a server that already exists ----------------------------------
  // The most likely person to download mcctl already runs a Minecraft server. Registering the
  // folder they have is a first-class path, not an advanced one, so the empty panel offers it
  // next to "create". Nothing is moved or rewritten - the core reads the ports and RCON password
  // out of the directory's own server.properties.
  if (seg[1] === 'instances' && seg[2] === 'adopt' && req.method === 'POST') {
    const body = await readBody(req)
    if (!body.name) return json(res, 400, { error: 'name is required' })
    if (!body.dir) return json(res, 400, { error: 'a server folder is required' })
    const inst = await create.adoptInstance(String(body.name), String(body.dir), {
      jar: body.jar ? String(body.jar) : null,
      memory: body.memory ? String(body.memory) : '4G',
    })
    return json(res, 200, safeInstance(inst))
  }

  if (seg[1] === 'instances' && req.method === 'POST' && seg.length === 2) {
    const body = await readBody(req)
    if (!body.name) return json(res, 400, { error: 'name is required' })
    const jobId = body.jobId ? String(body.jobId) : null
    try {
      let jar = body.jar || null
      if (body.paperVersion) {
        jobUpdate(jobId, { stage: 'resolve', percent: null, message: `Finding Paper ${body.paperVersion}` })
        const build = await paper.fetchBuild(String(body.paperVersion), null, {
          onProgress: ({ received, total, cached }) => {
            if (cached) return jobUpdate(jobId, { stage: 'cached', percent: 100, message: 'Server jar already downloaded' })
            jobUpdate(jobId, {
              stage: 'download',
              percent: total ? Math.min(100, Math.round((received / total) * 100)) : null,
              message: 'Downloading the server jar',
            })
          },
        })
        jar = build.name
      }
      jobUpdate(jobId, { stage: 'create', percent: null, message: 'Setting up the server folder' })
      const inst = await create.newInstance(String(body.name), {
        jar,
        memory: body.memory || '4G',
        port: body.port ? Number(body.port) : null,
        motd: body.motd || null,
        onlineMode: body.onlineMode !== false,
        // The panel is local and the person clicking Create is the operator; making them re-accept
        // the EULA in a second place would be ceremony, not consent.
        acceptEula: true,
      })
      jobUpdate(jobId, { stage: 'done', percent: 100, message: `Created ${inst.name}`, done: true })
      return json(res, 200, safeInstance(inst))
    } catch (err) {
      // The POST answers with the error too; the job carries it as well so a page that is watching
      // the stream shows the failure at the step it happened on rather than a bare rejected fetch.
      jobUpdate(jobId, { stage: 'error', message: err?.message ?? String(err), done: true })
      throw err
    }
  }

  const name = seg[2]
  if (!name || !registry.hasInstance(name)) return json(res, 404, { error: 'no such instance' })

  // ---- console stream (SSE) ------------------------------------------------
  if (seg[3] === 'stream' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    for (const line of supervisor.tailLog(name, 200)) {
      res.write(`data: ${JSON.stringify(line)}\n\n`)
    }
    const stop = supervisor.followLog(name, (line) => {
      res.write(`data: ${JSON.stringify(line)}\n\n`)
    })
    // A heartbeat keeps proxies and idle-timeouts from silently dropping a console that is simply
    // quiet — a stopped server produces no output, and a dead stream looks exactly the same.
    const beat = setInterval(() => res.write(': ping\n\n'), 20000)
    req.on('close', () => {
      clearInterval(beat)
      stop()
    })
    return
  }

  // Reads and writes, so it sits above the gate that allows only POST past this point.
  if (seg[3] === 'props') return handleProps(req, res, name)
  if (seg[3] === 'backups') return handleBackups(req, res, name, seg)
  if (seg[3] === 'schedules') return handleSchedules(req, res, name, seg)

  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

  /**
   * Start, and say so only if it actually started.
   *
   * <p>supervisor.start waits for Paper to report ready and returns whether it did. That result was
   * being thrown away, so a server that died on a bad jar, a taken port or an unaccepted EULA
   * answered 200 and the panel said "started" over a console full of the reason it had not.
   */
  const started = async () => {
    const out = await supervisor.start(name)
    const status = safeInstance(supervisor.statusOf(name))
    if (out.failed) return json(res, 500, { error: `"${name}" started but stopped again: ${out.reason}`, status })
    if (out.timedOut) return json(res, 504, { error: `"${name}" is taking longer than usual to come up. Watch the console - it may still finish.`, status })
    return json(res, 200, status)
  }

  if (seg[3] === 'start') return started()
  if (seg[3] === 'stop') {
    await supervisor.stop(name)
    return json(res, 200, safeInstance(supervisor.statusOf(name)))
  }
  if (seg[3] === 'restart') {
    await supervisor.stop(name).catch(() => {})
    return started()
  }
  if (seg[3] === 'rename') {
    const body = await readBody(req)
    if (!body.to) return json(res, 400, { error: 'new name is required' })
    return json(res, 200, manage.rename(name, String(body.to)))
  }
  if (seg[3] === 'rebuild') {
    const body = await readBody(req)
    return json(res, 200, await manage.rebuild(name, {
      keepPlugins: body.keepPlugins !== false,
      snapshot: body.snapshot !== false,
    }))
  }
  if (seg[3] === 'delete') {
    const body = await readBody(req)
    return json(res, 200, await manage.destroy(name, { purge: body.purge === true }))
  }
  if (seg[3] === 'reveal') {
    return json(res, 200, { dir: manage.reveal(name) })
  }
  if (seg[3] === 'settings') {
    const body = await readBody(req)
    // Only the fields the panel offers. An allowlist rather than a merge: a settings endpoint that
    // writes whatever it is handed is how a typo in the page silently rewrites the registry.
    const patch = {}
    if (body.memory) {
      // parseMemoryGb throws a readable message for anything that is not 4G or 6144M, and it is
      // the same parser the launcher uses - so what the panel accepts is exactly what will start.
      const memory = String(body.memory).trim()
      registry.parseMemoryGb(memory)
      patch.memory = memory
    }
    if (body.port) {
      const port = Number(body.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return json(res, 400, { error: `${body.port} is not a port number - use 1 to 65535.` })
      }
      // A port already spoken for by another instance would collide the next time both start, and
      // the failure would show up minutes later as a server that would not boot.
      const clash = registry.listInstances().find(
        (i) => i.name !== name && (i.port === port || i.rcon?.port === port),
      )
      if (clash) return json(res, 400, { error: `port ${port} is already used by "${clash.name}".` })
      patch.port = port
    }
    if (body.jar) patch.jar = String(body.jar)
    if (body.java) patch.java = String(body.java)
    registry.updateInstance(name, patch)
    return json(res, 200, safeInstance(supervisor.statusOf(name)))
  }
  if (seg[3] === 'command') {
    const body = await readBody(req)
    if (body.line == null || String(body.line).trim() === '') {
      return json(res, 400, { error: 'a command is required' })
    }
    await supervisor.sendConsole(name, String(body.line))
    return json(res, 200, { sent: true })
  }

  return json(res, 404, { error: 'not found' })
}

function openBrowser(url) {
  import('node:child_process').then(({ spawn }) => {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]]
    try {
      spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref()
    } catch {
      // No browser is not an error: the URL is printed either way.
    }
  })
}
