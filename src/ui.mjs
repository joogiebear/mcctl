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
import * as players from './players.mjs'
import * as metrics from './metrics.mjs'
import * as settings from './settings.mjs'
import * as plugins from './plugins.mjs'
import * as upgrade from './upgrade.mjs'
import * as fabric from './fabric.mjs'
import * as mrpack from './mrpack.mjs'
import * as neoforge from './neoforge.mjs'
import { acceptableWebhook } from './notify.mjs'

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
    group: 'access',
    label: 'Require a Minecraft account',
    type: 'bool',
    fallback: 'true',
    note: 'Off lets anyone join as any name, which is what multi-account testing needs - but it '
      + 'gives players name-derived UUIDs instead of real ones, and puts an OFFLINE/INSECURE '
      + 'banner in every log. Plugin authors often refuse a bug report carrying it.',
  },
  { key: 'motd', group: 'world', label: 'Message of the day', type: 'text', fallback: 'A Minecraft Server' },
  { key: 'difficulty', group: 'gameplay', label: 'Difficulty', type: 'enum', fallback: 'easy', options: ['peaceful', 'easy', 'normal', 'hard'] },
  { key: 'gamemode', group: 'gameplay', label: 'Default game mode', type: 'enum', fallback: 'survival', options: ['survival', 'creative', 'adventure', 'spectator'] },
  { key: 'max-players', group: 'access', label: 'Max players', type: 'int', fallback: '20', min: 1, max: 1000 },
  { key: 'pvp', group: 'gameplay', label: 'PvP', type: 'bool', fallback: 'true' },
  { key: 'white-list', group: 'access', label: 'Whitelist', type: 'bool', fallback: 'false', note: 'Only listed players can join. Add them from the console with "whitelist add <name>".' },
  { key: 'view-distance', group: 'world', label: 'View distance', type: 'int', fallback: '10', min: 2, max: 32 },
  { key: 'spawn-protection', group: 'gameplay', label: 'Spawn protection', type: 'int', fallback: '16', min: 0, max: 256 },
]

/**
 * How the settings screen is divided up.
 *
 * <p>Declared beside the fields rather than in the page, so the two cannot drift: a field added
 * above without a group still renders, in a section at the end, instead of quietly vanishing from
 * the only screen that can edit it.
 */
const PROP_GROUPS = [
  { key: 'access', icon: 'user', title: 'Who can join',
    blurb: 'Identity, the whitelist, and how many people at once.' },
  { key: 'gameplay', icon: 'play', title: 'Gameplay',
    blurb: 'The rules the world is played by.' },
  { key: 'world', icon: 'server', title: 'World and load',
    blurb: 'What players see before they join, and how much the server draws for them.' },
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
    return json(res, 200, { fields: shape(readProps(file)), groups: PROP_GROUPS, file, players: storedPlayers(inst.dir) })
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
    const auto = autoBackupTask(name)
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
    const existing = autoBackupTask(name)
    if (body.enabled === false) {
      if (existing) schedule.remove(existing.id)
      return json(res, 200, { auto: null })
    }
    // One automatic backup per server - the one this tab owns. A second would race the first for
    // the same tar and prune each other's output. Tasks the user made in the Scheduler tab are not
    // this tab's to touch, and autoBackupTask is what keeps them out of it.
    //
    // Changed in place rather than removed and remade. The old order deleted a working schedule
    // first, so a create that then failed - Task Scheduler service stopped, a transient schtasks
    // error - left the server with no automatic backup at all and a toggle that still read On.
    const keep = Number(body.keep)
    const action = { type: 'backup', keep: Number.isInteger(keep) && keep > 0 ? keep : null }
    const when = body.schedule ?? { kind: 'daily', at: '03:00' }
    const made = existing
      ? schedule.update(existing.id, { action, schedule: when, enabled: true, owner: schedule.OWNER_BACKUPS })
      : schedule.create({ instance: name, name: 'Automatic backup', action, schedule: when, owner: schedule.OWNER_BACKUPS })
    return json(res, 200, { auto: { id: made.id, schedule: made.schedule, keep: made.action.keep } })
  }

  return json(res, 404, { error: 'not found' })
}

/**
 * The one automatic backup the Backups tab owns for this server.
 *
 * <p>Identified by its owner mark, never by "a task whose action is backup" - the Scheduler tab
 * lets people make those too, and matching one of theirs meant the toggle deleted it.
 *
 * <p>The fallback adopts a task made before the mark existed. It is deliberately narrow: the
 * Backups tab has only ever created this task under one name, so a task with that exact name and
 * no owner is one of ours, and anything else is left alone.
 */
function autoBackupTask(name) {
  const mine = schedule.list().filter((t) => t.instance === name && t.action.type === 'backup')
  return mine.find((t) => t.owner === schedule.OWNER_BACKUPS)
    ?? mine.find((t) => !t.owner && t.name === 'Automatic backup')
    ?? null
}

/**
 * How hard this server has been working.
 *
 * <p>Read from the file the daemon writes rather than measured here: the panel is a different
 * process that may have been started after the server, and CPU is a rate that needs two readings
 * taken by whoever was watching at the time.
 */
function handleMetrics(req, res, name, url) {
  registry.getInstance(name)
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })

  const asked = Number(url.searchParams.get('seconds'))
  // Capped at what is kept. Asking for a day gets everything there is rather than an error.
  const seconds = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 18000) : 3600
  const status = supervisor.statusOf(name)
  const all = metrics.readSamples(name)
  const cutoff = Math.floor(Date.now() / 1000) - seconds
  // Both the window and what lies outside it. A stopped server whose last run ended an hour ago
  // has nothing in the last five minutes and plenty on disk, and the page has to be able to tell
  // "never measured" from "not in this range" - they call for opposite things to say.
  const newest = all.length ? all[all.length - 1].at : null
  return json(res, 200, {
    samples: all.filter((s) => s.at >= cutoff),
    history: {
      count: all.length,
      oldest: all.length ? all[0].at : null,
      newest,
      // How far back the shortest range would have to reach to catch anything, so the page can
      // name one rather than inviting someone to try all five.
      staleSeconds: newest === null ? null : Math.max(0, Math.floor(Date.now() / 1000) - newest),
    },
    everySeconds: metrics.SAMPLE_SECONDS,
    cores: metrics.CPU_CORES,
    running: supervisor.isRunning(name),
    uptimeMs: status.uptimeMs ?? null,
    startedAt: status.startedAt ?? null,
    memory: status.memory ?? null,
  })
}

/**
 * The server software itself: what Paper offers, and moving to it.
 *
 * <p>GET asks PaperMC what exists - on demand only, so the panel stays off the network until
 * the person clicks. POST with no version is a routine build update; POST naming a version
 * crosses Minecraft versions, which the page has already made someone confirm, and
 * applyUpgrade takes a standard snapshot before anything is swapped.
 */
async function handleUpgrade(req, res, name) {
  const inst = registry.getInstance(name)
  if (req.method === 'GET') {
    return json(res, 200, await upgrade.checkUpgrade(inst))
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
  const body = await readBody(req)
  const result = await upgrade.applyUpgrade(name, {
    version: body.version ? String(body.version) : null,
    running: supervisor.isRunning(name),
  })
  return json(res, 200, { ...result, running: supervisor.isRunning(name) })
}

/**
 * A modpack server's pack: what release it runs, whether a newer one exists, and moving to
 * it. The update refuses a running server in the core - files must not change under a live
 * JVM - and narrates through the same job stream creation uses, because it is the same
 * dozens-of-downloads shape.
 */
async function handlePack(req, res, name) {
  const inst = registry.getInstance(name)
  if (req.method === 'GET') {
    return json(res, 200, {
      ...(await mrpack.checkPackUpdate(inst)),
      running: supervisor.isRunning(name),
    })
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
  const body = await readBody(req)
  const jobId = body.jobId ? String(body.jobId) : null
  try {
    const result = await mrpack.updatePack(name, {
      onProgress: ({ message, percent }) => jobUpdate(jobId, { stage: 'pack', message, percent: percent ?? null }),
    })
    jobUpdate(jobId, { stage: 'done', percent: 100, message: 'Pack updated', done: true })
    return json(res, 200, result)
  } catch (err) {
    jobUpdate(jobId, { stage: 'error', message: err?.message ?? String(err), done: true })
    throw err
  }
}

/**
 * Plugins: what the server loads, and what Modrinth can add to it.
 *
 * <p>The installed list needs no network and always answers. Search, install and the update
 * check reach Modrinth and fail with a readable message when they cannot - the panel offline
 * still manages what is already on disk.
 */
async function handlePlugins(req, res, name, seg, url) {
  const inst = registry.getInstance(name)
  const verb = seg[4] ?? null
  const gameVersion = plugins.mcVersionOf(inst)
  // Plugins on a Paper-family server, mods on a Fabric one - same tab, different folder,
  // vocabulary and Modrinth facet. Hangar hosts only plugins, so mods skip it entirely.
  const kind = plugins.contentKindFor(inst)

  if (req.method === 'GET' && !verb) {
    const pack = mrpack.packOf(inst)
    return json(res, 200, {
      plugins: plugins.listPlugins(inst),
      running: supervisor.isRunning(name),
      gameVersion,
      kind: kind.kind,
      word: kind.word,
      hangar: kind.hangar,
      // Enough for the page to say what built this server and what a joining player needs.
      pack: pack ? { name: pack.name, version: pack.versionNumber, project: pack.project } : null,
    })
  }
  if (req.method === 'GET' && verb === 'search') {
    const q = String(url.searchParams.get('q') || '').trim()
    if (!q) return json(res, 200, { results: [], errors: [] })
    // Both sources at once. One being down must not blank the other's answers, so each
    // failure becomes a note beside the results rather than an error instead of them.
    const asks = [
      plugins.searchPlugins(q, {
        loaders: plugins.loadersFor(inst),
        projectType: kind.projectType,
      }),
    ]
    if (kind.hangar) asks.push(plugins.searchHangar(q))
    const [modrinthHits, hangarHits] = await Promise.allSettled(asks)
    const errors = []
    if (modrinthHits.status === 'rejected') errors.push(modrinthHits.reason?.message ?? 'Modrinth search failed')
    if (hangarHits && hangarHits.status === 'rejected') errors.push(hangarHits.reason?.message ?? 'Hangar search failed')
    return json(res, 200, {
      results: [
        ...(modrinthHits.value ?? []),
        ...(hangarHits?.value ?? []),
      ],
      errors,
    })
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
  const body = await readBody(req)

  if (verb === 'toggle') {
    return json(res, 200, plugins.setPluginEnabled(inst, String(body.file), body.enabled === true))
  }
  if (verb === 'delete') {
    return json(res, 200, plugins.removePlugin(inst, String(body.file)))
  }
  if (verb === 'install') {
    if (!body.projectId) return json(res, 400, { error: 'projectId is required' })
    const result = body.source === 'hangar'
      ? await plugins.installFromHangar(inst, String(body.projectId), { gameVersion })
      : await plugins.installPlugin(inst, String(body.projectId), { gameVersion })
    return json(res, 200, result)
  }
  if (verb === 'updates') {
    return json(res, 200, { updates: await plugins.checkUpdates(inst, { gameVersion }) })
  }
  if (verb === 'update') {
    // A snapshot of the plugins alone before anything is replaced: small, fast, and the way
    // back when the new build turns out to be the wrong one.
    await backup.createSnapshot(inst, {
      scope: 'plugins', label: 'pre-update', running: supervisor.isRunning(name),
    })
    return json(res, 200, await plugins.updatePlugin(inst, String(body.file), { gameVersion }))
  }
  return json(res, 404, { error: 'not found' })
}

/**
 * Who a server knows about, and what it thinks of them.
 *
 * <p>Every write goes through players.mjs rather than being decided here, because whether a change
 * belongs in a file or down the console depends on whether the server is running - and getting
 * that wrong is invisible until the next restart undoes it.
 */
async function handlePlayers(req, res, name, seg) {
  const inst = registry.getInstance(name)
  const verb = seg[4] ?? null

  if (req.method === 'GET') {
    const here = new Set((await players.onlineNow(inst)).map((n) => n.toLowerCase()))
    const rows = players.listPlayers(inst).map((p) => ({
      ...p,
      online: Boolean(p.name && here.has(p.name.toLowerCase())),
      // Somebody standing in the world has joined it, whatever the files say - the .dat is not
      // written until they log out or the world saves.
      joined: p.joined || Boolean(p.name && here.has(p.name.toLowerCase())),
    }))
    return json(res, 200, {
      players: rows,
      running: supervisor.isRunning(name),
      // Whether a name can be recovered at all depends on this, and the tab explains the
      // difference rather than leaving an id where a name should be.
      onlineMode: safeInstance(supervisor.statusOf(name)).onlineMode,
    })
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

  const body = await readBody(req)
  if (!body.uuid) return json(res, 400, { error: 'which player?' })
  const uuid = String(body.uuid)

  if (verb === 'op') return json(res, 200, await players.setOp(inst, uuid, body.on !== false))
  if (verb === 'ban') return json(res, 200, await players.setBan(inst, uuid, body.on !== false, body.reason))
  if (verb === 'forget') return json(res, 200, players.forgetPlayer(inst, uuid))

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

  // Reserved, because autoBackupTask still recognises a task by this name when it has no owner
  // mark - that is how a schedule made before the mark existed is adopted. A task the user named
  // the same thing would be adopted instead, and the toggle would then delete it.
  if (body.name !== undefined && String(body.name).trim().toLowerCase() === 'automatic backup') {
    return json(res, 400, {
      error: '"Automatic backup" is the name the Backups tab uses for the schedule behind its own '
        + 'toggle. Pick another so the two cannot be confused.',
    })
  }

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
  if (seg[1] === 'fabric' && seg[2] === 'versions' && req.method === 'GET') {
    return json(res, 200, await fabric.versions())
  }
  if (seg[1] === 'neoforge' && seg[2] === 'versions' && req.method === 'GET') {
    return json(res, 200, await neoforge.versions())
  }
  if (seg[1] === 'modpacks' && seg[2] === 'search' && req.method === 'GET') {
    const q = String(url.searchParams.get('q') || '').trim()
    return json(res, 200, { results: q ? await plugins.searchModpacks(q) : [] })
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
      // A modpack is a whole different creation path: the pack decides the loader, the
      // Minecraft version, the mods and the config; the person decides the name and memory.
      if (body.modpack) {
        const result = await mrpack.createFromModpack(String(body.name), String(body.modpack), {
          memory: body.memory || '4G',
          port: body.port ? Number(body.port) : null,
          onlineMode: body.onlineMode !== false,
          onProgress: ({ message, percent }) => jobUpdate(jobId, { stage: 'pack', message, percent: percent ?? null }),
        })
        jobUpdate(jobId, { stage: 'done', percent: 100, message: `Created ${result.name}`, done: true })
        return json(res, 200, { ...safeInstance(supervisor.statusOf(String(body.name))), pack: result })
      }
      // NeoForge is its own creation path too: installer-laid, starter-jar launched, and the
      // whole build-or-tear-down flow lives in neoforge.createServer.
      if (body.loader === 'neoforge') {
        if (!body.neoforgeVersion) return json(res, 400, { error: 'a Minecraft version is required for a NeoForge server' })
        const result = await neoforge.createServer(String(body.name), String(body.neoforgeVersion), {
          memory: body.memory || '4G',
          port: body.port ? Number(body.port) : null,
          onlineMode: body.onlineMode !== false,
          onProgress: ({ message, percent }) => jobUpdate(jobId, { stage: 'neoforge', message, percent: percent ?? null }),
        })
        jobUpdate(jobId, { stage: 'done', percent: 100, message: `Created ${result.name}`, done: true })
        return json(res, 200, safeInstance(supervisor.statusOf(String(body.name))))
      }
      const loader = body.loader === 'fabric' ? 'fabric' : 'paper'
      const onProgress = ({ received, total, cached }) => {
        if (cached) return jobUpdate(jobId, { stage: 'cached', percent: 100, message: 'Server jar already downloaded' })
        jobUpdate(jobId, {
          stage: 'download',
          percent: total ? Math.min(100, Math.round((received / total) * 100)) : null,
          message: 'Downloading the server jar',
        })
      }
      if (loader === 'fabric') {
        if (!body.fabricVersion) return json(res, 400, { error: 'a Minecraft version is required for a Fabric server' })
        jobUpdate(jobId, { stage: 'resolve', percent: null, message: `Finding Fabric for ${body.fabricVersion}` })
        const launcher = await fabric.fetchLauncher(String(body.fabricVersion), { onProgress })
        jar = launcher.name
      } else if (body.paperVersion) {
        jobUpdate(jobId, { stage: 'resolve', percent: null, message: `Finding Paper ${body.paperVersion}` })
        const build = await paper.fetchBuild(String(body.paperVersion), null, { onProgress })
        jar = build.name
      }
      jobUpdate(jobId, { stage: 'create', percent: null, message: 'Setting up the server folder' })
      const inst = await create.newInstance(String(body.name), {
        jar,
        loader,
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
  if (seg[3] === 'players') return handlePlayers(req, res, name, seg)
  if (seg[3] === 'plugins') return handlePlugins(req, res, name, seg, url)
  if (seg[3] === 'upgrade') return handleUpgrade(req, res, name)
  if (seg[3] === 'pack') return handlePack(req, res, name)
  if (seg[3] === 'metrics') return handleMetrics(req, res, name, url)

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
    if (body.jar) {
      // Placed before it is recorded, for the reason spelled out on placeJar: an instance runs the
      // jar in its own directory, and a registry entry naming one that is not there is a server
      // that cannot start. Throws a readable message when the jar is not in the store.
      patch.jar = String(body.jar)
      create.placeJar(registry.getInstance(name).dir, patch.jar)
    }
    if (body.java) patch.java = String(body.java)
    if (Object.hasOwn(body, 'autoRestart')) patch.autoRestart = body.autoRestart === true
    if (Object.hasOwn(body, 'webhook')) {
      const url = String(body.webhook ?? '').trim()
      if (url && !acceptableWebhook(url)) {
        return json(res, 400, { error: 'the webhook must be an http(s) URL - paste the one Discord gives you.' })
      }
      patch.webhook = url || null
    }
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
