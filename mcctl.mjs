#!/usr/bin/env node
/**
 * mcctl - local Minecraft server control plane.
 *
 * Manages multiple server instances on this machine: detached launch with
 * captured console, RCON command/response, stdin injection, and snapshots.
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { spawnSync } from 'node:child_process'

import { ensureDirs, ROOT, runDir } from './src/paths.mjs'
import { listInstances, getInstance, removeInstance, updateInstance, serverJarPath } from './src/registry.mjs'
import { readState, clearState } from './src/control.mjs'
import * as sup from './src/supervisor.mjs'
import { rconExec, stripColors } from './src/rcon.mjs'
import * as backup from './src/backup.mjs'
import * as create from './src/create.mjs'
import * as paper from './src/paper.mjs'
import * as ui from './src/ui.mjs'
import * as manage from './src/manage.mjs'
import * as settings from './src/settings.mjs'
import * as java from './src/java.mjs'
import * as schedule from './src/schedule.mjs'
import * as paths from './src/paths.mjs'
import { readProps, writeProps } from './src/props.mjs'
import { UserError, fail, table, humanBytes, humanDuration, dirSize, isPortFree } from './src/util.mjs'

// ---------------------------------------------------------------- arg parsing

function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (arg.startsWith('--')) {
      const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/s)
      const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      if (inlineValue !== undefined) {
        flags[key] = inlineValue
      } else if (rawKey.startsWith('no-')) {
        flags[rawKey.slice(3).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = false
      } else if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
        flags[key] = argv[++i]
      } else {
        flags[key] = true
      }
    } else if (/^-[a-zA-Z]$/.test(arg)) {
      const key = arg.slice(1)
      if (argv[i + 1] && !argv[i + 1].startsWith('-')) flags[key] = argv[++i]
      else flags[key] = true
    } else {
      positional.push(arg)
    }
  }
  return { flags, positional }
}

const out = (msg = '') => process.stdout.write(`${msg}\n`)

function requireName(positional, command) {
  const name = positional[0]
  if (!name) fail(`${command} requires an instance name. See: mcctl list`)
  return name
}

// -------------------------------------------------------------------- display

const STATUS_LABEL = {
  running: 'running',
  stopped: 'stopped',
  stopping: 'stopping',
  orphaned: 'ORPHANED',
  stale: 'stale',
}

function cmdList() {
  const instances = listInstances()
  if (!instances.length) {
    out('No instances registered.')
    out('')
    out('  Adopt an existing server:  mcctl adopt <name> <path-to-server-dir>')
    out('  Create a fresh one:        mcctl new <name> --jar <jar> --accept-eula')
    return
  }
  const rows = [['NAME', 'STATUS', 'PORT', 'RCON', 'MEM', 'UPTIME', 'DIR']]
  for (const inst of instances) {
    const { status, state } = readState(inst.name)
    rows.push([
      inst.name,
      STATUS_LABEL[status] ?? status,
      inst.port,
      inst.rcon?.port ?? '-',
      inst.memory,
      status === 'running' && state?.startedAt ? humanDuration(Date.now() - state.startedAt) : '-',
      inst.dir,
    ])
  }
  out(table(rows))
}

function cmdStatus(positional) {
  if (!positional[0]) return cmdList()
  const name = positional[0]
  const st = sup.statusOf(name)
  const props = readProps(path.join(st.dir, 'server.properties'))
  const rows = [
    ['instance', st.name],
    ['status', STATUS_LABEL[st.status] ?? st.status],
    ['directory', st.dir],
    ['jar', st.jar],
    ['memory', st.memory],
    ['java', st.java || 'java'],
    ['port', String(st.port)],
    ['rcon port', String(st.rcon?.port ?? '-')],
    ['level-name', props.get('level-name') ?? '(unset)'],
    ['motd', props.get('motd') ?? '(unset)'],
    ['online-mode', props.get('online-mode') ?? '(unset)'],
  ]
  if (st.status === 'running' || st.status === 'stopping') {
    rows.push(['java pid', String(st.javaPid)], ['daemon pid', String(st.daemonPid)], ['uptime', humanDuration(st.uptimeMs)])
  } else if (st.exitCode !== null && st.exitCode !== undefined) {
    rows.push(['last exit code', String(st.exitCode)])
  }
  rows.push(['console log', st.consoleLog])
  out(table(rows.map(([k, v]) => [`${k}:`, v])))
}

// --------------------------------------------------------------- lifecycle

async function cmdStart(positional, flags) {
  const name = requireName(positional, 'start')
  const wait = flags.wait !== false && !flags.detach
  const timeout = Number(flags.timeout ?? 180) * 1000
  out(`Starting "${name}"...`)
  const res = await sup.start(name, { wait, timeout, sync: flags.sync !== false })

  if (!wait) {
    out(`Launched (java pid ${res.javaPid}). Not waiting for ready.`)
    out(`Follow with: mcctl logs ${name} -f`)
    return
  }
  if (res.ready) {
    const inst = getInstance(name)
    out(`Ready - ${res.readyLine}`)
    out(`  java pid ${res.javaPid}   port ${inst.port}   rcon ${inst.rcon.port}`)
    return
  }
  if (res.failed) {
    out(`Server did not reach ready state: ${res.reason}`)
    out('')
    out('Last 25 console lines:')
    for (const line of sup.tailLog(name, 25)) out(`  ${line}`)
    process.exitCode = 1
    return
  }
  out(`Timed out after ${timeout / 1000}s waiting for ready. The server may still be loading.`)
  out(`Follow with: mcctl logs ${name} -f`)
  process.exitCode = 1
}

async function cmdStop(positional, flags) {
  const name = requireName(positional, 'stop')
  const timeout = Number(flags.timeout ?? 90) * 1000
  out(`Stopping "${name}"...`)
  const res = await sup.stop(name, { timeout })
  if (res.alreadyStopped) out(`"${name}" was not running.`)
  else if (res.forced) out(`"${name}" did not shut down gracefully and was killed.`)
  else out(`"${name}" stopped (exit code ${res.code ?? 0}).`)
}

async function cmdRestart(positional, flags) {
  const name = requireName(positional, 'restart')
  const { status } = readState(name)
  if (status === 'running' || status === 'stopping') {
    out(`Stopping "${name}"...`)
    await sup.stop(name, { timeout: Number(flags.timeout ?? 90) * 1000 })
  }
  await cmdStart(positional, flags)
}

async function cmdKill(positional) {
  const name = requireName(positional, 'kill')
  const res = await sup.kill(name)
  if (res.alreadyStopped) out(`"${name}" was not running.`)
  else out(`"${name}" force-killed.`)
}

// ------------------------------------------------------------------- console

function cmdLogs(positional, flags) {
  const name = requireName(positional, 'logs')
  getInstance(name)
  const count = Number(flags.n ?? flags.lines ?? 60)
  const grep = flags.grep ? new RegExp(flags.grep, 'i') : null

  const lines = sup.tailLog(name, grep ? Math.max(count, 5000) : count)
  const shown = grep ? lines.filter((l) => grep.test(l)).slice(-count) : lines
  for (const line of shown) out(line)

  if (flags.f || flags.follow) {
    out('--- following (ctrl-c to stop) ---')
    sup.followLog(name, (line) => {
      if (!grep || grep.test(line)) out(line)
    })
    return new Promise(() => {}) // follow until interrupted
  }
  return undefined
}

async function cmdCmd(positional, flags) {
  const name = requireName(positional, 'cmd')
  const command = positional.slice(1).join(' ').trim()
  if (!command) fail('cmd requires a command, e.g. mcctl cmd survival "tps"')
  const inst = getInstance(name)
  if (!sup.isRunning(name)) fail(`instance "${name}" is not running`)

  const [response] = await rconExec(inst, [command])
  const text = flags.raw ? response : stripColors(response)
  if (text.trim()) out(text.trimEnd())
  else out('(no output)')
}

async function cmdSend(positional) {
  const name = requireName(positional, 'send')
  const line = positional.slice(1).join(' ')
  if (!line.trim()) fail('send requires a line to write to the server console')
  await sup.sendConsole(name, line)
  out(`> ${line}`)
}

async function cmdPlayers(positional) {
  const name = requireName(positional, 'players')
  const inst = getInstance(name)
  if (!sup.isRunning(name)) fail(`instance "${name}" is not running`)
  const [res] = await rconExec(inst, ['list'])
  out(stripColors(res).trim())
}

async function cmdConsole(positional) {
  const name = requireName(positional, 'console')
  getInstance(name)
  if (!sup.isRunning(name)) fail(`instance "${name}" is not running`)

  out(`--- attached to "${name}" (ctrl-c or "/detach" to leave; the server keeps running) ---`)
  for (const line of sup.tailLog(name, 20)) out(line)

  const stop = sup.followLog(name, (line) => out(line))
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' })

  await new Promise((resolve) => {
    rl.on('line', async (line) => {
      const trimmed = line.trim()
      if (trimmed === '/detach' || trimmed === '/exit') {
        rl.close()
        return
      }
      if (!trimmed) return
      try {
        await sup.sendConsole(name, trimmed)
      } catch (err) {
        out(`[mcctl] ${err.message}`)
      }
    })
    rl.on('close', resolve)
    rl.on('SIGINT', () => rl.close())
  })
  stop()
  out(`--- detached from "${name}" (still running) ---`)
}

// --------------------------------------------------------------- provisioning

async function cmdNew(positional, flags) {
  const name = requireName(positional, 'new')

  // --paper <version> makes "spin up a fresh environment on version X" one command instead of
  // three. Downloading first means a failed fetch leaves no half-made instance behind.
  let jar = flags.jar ?? null
  if (flags.paper) {
    const build = await paper.fetchBuild(String(flags.paper), flags.build ?? null)
    out(build.cached
      ? `Using stored ${build.name} (build ${build.build}, ${build.channel}).`
      : `Downloaded ${build.name} — build ${build.build}, ${build.channel}, ${build.sizeHuman}.`)
    jar = build.name
  }

  const inst = await create.newInstance(name, {
    template: flags.template ?? null,
    from: flags.from ?? null,
    withWorlds: Boolean(flags.withWorlds),
    jar,
    memory: flags.memory ?? '4G',
    port: flags.port ? Number(flags.port) : null,
    rconPort: flags.rconPort ? Number(flags.rconPort) : null,
    acceptEula: Boolean(flags.acceptEula),
    // --offline for joining as any name without an account, which is what multi-account testing
    // needs. It also puts an OFFLINE/INSECURE banner in every log the server writes, so it is a
    // choice rather than the default.
    onlineMode: !flags.offline,
    motd: flags.motd ?? null,
    java: flags.java ?? 'java',
  })
  out(`Created instance "${inst.name}"`)
  out(table([
    ['directory:', inst.dir],
    ['jar:', inst.jar],
    ['memory:', inst.memory],
    ['port:', String(inst.port)],
    ['rcon port:', String(inst.rcon.port)],
  ]))
  if (!inst.eulaAccepted) {
    out('')
    out('EULA is NOT accepted. The server will refuse to start until you either')
    out(`  set eula=true in ${path.join(inst.dir, 'eula.txt')}`)
    out('  (see https://aka.ms/MinecraftEULA)')
  } else {
    out('')
    out(`Start it with: mcctl start ${inst.name}`)
  }
}

async function cmdClone(positional, flags) {
  const src = positional[0]
  const dst = positional[1]
  if (!src || !dst) fail('clone requires a source and a destination: mcctl clone <src> <new-name>')
  const inst = await create.newInstance(dst, {
    from: src,
    withWorlds: Boolean(flags.withWorlds),
    memory: flags.memory ?? getInstance(src).memory,
    port: flags.port ? Number(flags.port) : null,
    acceptEula: flags.acceptEula !== false, // the source already accepted it
    motd: flags.motd ?? `${dst} (clone of ${src})`,
  })
  out(`Cloned "${src}" -> "${dst}"${flags.withWorlds ? ' (with worlds)' : ' (fresh worlds)'}`)
  out(table([
    ['directory:', inst.dir],
    ['port:', String(inst.port)],
    ['rcon port:', String(inst.rcon.port)],
  ]))
  out('')
  out(`Start it with: mcctl start ${dst}`)
}

async function cmdAdopt(positional, flags) {
  const name = positional[0]
  const dir = positional[1]
  if (!name || !dir) fail('adopt requires a name and a directory: mcctl adopt <name> <server-dir>')
  const inst = await create.adoptInstance(name, dir, {
    jar: flags.jar ?? null,
    memory: flags.memory ?? '4G',
    java: flags.java ?? 'java',
  })
  out(`Adopted "${inst.name}"`)
  out(table([
    ['directory:', inst.dir],
    ['jar:', inst.jar],
    ['memory:', inst.memory],
    ['port:', String(inst.port)],
    ['rcon port:', String(inst.rcon.port)],
  ]))
}

function cmdRemove(positional, flags) {
  const name = requireName(positional, 'rm')
  const inst = getInstance(name)
  if (sup.isRunning(name)) fail(`instance "${name}" is running - stop it first`)
  if (flags.purge && !flags.yes) {
    fail(`--purge deletes ${inst.dir} permanently. Re-run with --yes to confirm.`)
  }
  removeInstance(name)
  if (flags.purge) {
    fs.rmSync(inst.dir, { recursive: true, force: true })
    out(`Removed "${name}" and deleted ${inst.dir}`)
  } else {
    out(`Unregistered "${name}". Files kept at ${inst.dir}`)
  }
  fs.rmSync(runDir(name), { recursive: true, force: true })
}

function cmdSet(positional) {
  const name = requireName(positional, 'set')
  const assignments = positional.slice(1)
  if (!assignments.length) fail('set requires key=value pairs, e.g. mcctl set survival memory=8G')
  const patch = {}
  const inst = getInstance(name)
  for (const pair of assignments) {
    const [key, ...rest] = pair.split('=')
    const value = rest.join('=')
    if (!value) fail(`malformed assignment "${pair}" - expected key=value`)
    switch (key) {
      case 'memory':
        patch.memory = value
        break
      case 'java':
        patch.java = value
        break
      case 'jar':
        patch.jar = value
        break
      case 'port':
        patch.port = Number(value)
        break
      case 'rcon.port':
        patch.rcon = { ...(patch.rcon ?? inst.rcon), port: Number(value) }
        break
      case 'rcon.password':
        patch.rcon = { ...(patch.rcon ?? inst.rcon), password: value }
        break
      default:
        fail(`unknown setting "${key}" - one of: memory, java, jar, port, rcon.port, rcon.password`)
    }
  }
  updateInstance(name, patch)
  out(`Updated "${name}":`)
  for (const [k, v] of Object.entries(patch)) out(`  ${k} = ${typeof v === 'object' ? JSON.stringify(v) : v}`)
  if (sup.isRunning(name)) out('Restart the instance for changes to take effect.')
}

function cmdProps(positional) {
  const name = requireName(positional, 'props')
  const inst = getInstance(name)
  const file = path.join(inst.dir, 'server.properties')
  const assignments = positional.slice(1)

  if (!assignments.length) {
    const props = readProps(file)
    out(table([...props.entries()].sort().map(([k, v]) => [`${k}:`, v])))
    return
  }
  const updates = {}
  for (const pair of assignments) {
    const [key, ...rest] = pair.split('=')
    if (!rest.length) fail(`malformed assignment "${pair}" - expected key=value`)
    updates[key] = rest.join('=')
  }
  writeProps(file, updates)
  out(`Updated ${file}:`)
  for (const [k, v] of Object.entries(updates)) out(`  ${k}=${v}`)
  if (sup.isRunning(name)) out('Restart the instance for changes to take effect.')
}

// ------------------------------------------------------------------- backups

async function cmdBackup(positional, flags) {
  const name = requireName(positional, 'backup')
  const inst = getInstance(name)
  const scope = flags.scope ?? 'standard'
  const running = sup.isRunning(name)

  // Flushing to disk first makes a hot snapshot of a live world coherent.
  if (running && flags.flush !== false) {
    out('Flushing world to disk (save-all)...')
    try {
      await rconExec(inst, ['save-off', 'save-all flush'])
    } catch (err) {
      out(`  warning: could not flush via RCON (${err.message})`)
    }
  }
  try {
    out(`Snapshotting "${name}" (scope: ${scope})...`)
    const res = await backup.createSnapshot(inst, { scope, label: flags.label ?? null, running })
    out(`Wrote ${res.file} (${humanBytes(res.size)})`)
    out(`  included: ${res.members.join(', ')}`)
    if (res.manifest.warnings.length) {
      out('  tar warnings (normal for a live server):')
      for (const w of res.manifest.warnings) out(`    ${w}`)
    }
  } finally {
    if (running && flags.flush !== false) {
      try {
        await rconExec(inst, ['save-on'])
      } catch {
        /* server may have stopped mid-backup */
      }
    }
  }
  if (flags.keep) {
    const removed = backup.pruneSnapshots(name, Number(flags.keep))
    if (removed.length) out(`Pruned ${removed.length} old snapshot(s), keeping ${flags.keep}.`)
  }
}

function cmdSnapshots(positional) {
  const name = requireName(positional, 'snapshots')
  getInstance(name)
  const snaps = backup.listSnapshots(name)
  if (!snaps.length) {
    out(`No snapshots for "${name}". Create one with: mcctl backup ${name}`)
    return
  }
  const rows = [['NAME', 'SCOPE', 'SIZE', 'CREATED']]
  for (const s of snaps) rows.push([s.name, s.scope, s.sizeHuman, s.mtime.toISOString().replace('T', ' ').slice(0, 19)])
  out(table(rows))
}

async function cmdRestore(positional, flags) {
  const name = requireName(positional, 'restore')
  const inst = getInstance(name)
  if (sup.isRunning(name)) fail(`instance "${name}" is running - stop it before restoring`)
  const snap = backup.resolveSnapshot(name, positional[1] ?? 'latest')

  if (!flags.yes) {
    out(`About to restore into ${inst.dir}:`)
    out(`  snapshot: ${snap.name} (${snap.sizeHuman}, scope ${snap.scope})`)
    out(`  overwrites: ${snap.members.join(', ') || '(see manifest)'}`)
    out('')
    out('This overwrites existing files in place. Re-run with --yes to proceed.')
    process.exitCode = 1
    return
  }
  const res = await backup.restoreSnapshot(inst, snap)
  out(`Restored ${res.restored} into ${res.into}`)
}

function cmdPrune(positional, flags) {
  const name = requireName(positional, 'prune')
  getInstance(name)
  const keep = Number(flags.keep ?? 10)
  const removed = backup.pruneSnapshots(name, keep)
  out(removed.length ? `Removed ${removed.length} snapshot(s), keeping the newest ${keep}.` : 'Nothing to prune.')
}

// ------------------------------------------------------- templates and jars

function cmdTemplates(positional, flags) {
  const sub = positional[0]
  if (sub === 'save') {
    const instName = positional[1]
    const tplName = positional[2]
    if (!instName || !tplName) fail('usage: mcctl templates save <instance> <template-name>')
    const res = create.saveTemplate(getInstance(instName), tplName, { includeWorlds: Boolean(flags.withWorlds) })
    out(`Saved template "${res.name}" -> ${res.dir}`)
    return
  }
  const tpls = create.listTemplates()
  if (!tpls.length) {
    out('No templates. Create one from an existing instance:')
    out('  mcctl templates save <instance> <template-name>')
    return
  }
  const rows = [['NAME', 'JAR', 'WORLDS', 'FROM']]
  for (const t of tpls) rows.push([t.name, t.jar ?? '-', t.includesWorlds ? 'yes' : 'no', t.sourceInstance ?? '-'])
  out(table(rows))
}

function cmdConfig(positional, flags) {
  const sub = positional[0]

  if (!sub || sub === 'show') {
    const l = paths.LAYOUT
    out(table([
      ['settings file:', l.settingsFile],
      ['data root:', l.dataRoot],
      ['instances:', l.instancesDir + (l.separateInstances ? '   (separate location)' : '')],
      ['jars:', l.jarsDir],
      ['backups:', l.backupsDir],
      ['templates:', l.templatesDir],
      ['run state:', l.runDir],
    ]))
    if (l.usingLegacyLayout) {
      out('')
      out('Using the folder mcctl lives in, because it already holds instances.json.')
      out('Move it with: mcctl config set-root <path>')
    }
    return
  }

  if (sub === 'set-root' || sub === 'set-instances') {
    const dir = positional[1]
    if (!dir) fail(`usage: mcctl config ${sub} <path>`)
    const abs = path.resolve(dir)
    const check = settings.checkWritable(abs)
    // Written to, not merely inspected: permission bits and free-space numbers both lie about a
    // network share, a read-only mount, or a drive that has been unplugged.
    if (!check.ok) fail(`cannot write to ${abs}
  ${check.error}`)

    settings.save(sub === 'set-root'
      ? { dataRoot: abs }
      : { instancesDir: abs, separateInstances: true })
    out(`Saved. ${sub === 'set-root' ? 'Data root' : 'Instances directory'}: ${abs}`)
    out('')
    out('Takes effect on the next command. Existing servers do NOT move — the registry stores')
    out('their absolute paths, so they keep running where they are; only new ones land here.')
    return
  }

  if (sub === 'same-drive') {
    settings.save({ separateInstances: false })
    out('Servers will be created under the data root again.')
    return
  }

  fail('usage: mcctl config [show|set-root <path>|set-instances <path>|same-drive]')
}

function cmdRename(positional) {
  const from = positional[0]
  const to = positional[1]
  if (!from || !to) fail('usage: mcctl rename <old-name> <new-name>')
  const res = manage.rename(from, to)
  out(`Renamed "${from}" -> "${to}"`)
  if (res.movedDir) out(`  directory moved to ${res.dir}`)
  create.writeLaunchers(res)
}

async function cmdRebuild(positional, flags) {
  const name = requireName(positional, 'rebuild')
  if (!flags.yes) {
    fail(`rebuild deletes the worlds in "${name}". Re-run with --yes to confirm.
` +
      `  Add --wipe-plugins to reset plugins too. A snapshot is taken first unless --no-snapshot.`)
  }
  const res = await manage.rebuild(name, {
    keepPlugins: !flags.wipePlugins,
    snapshot: !flags.noSnapshot,
  })
  if (res.snapshot) out(`Snapshot: ${res.snapshot}`)
  out(`Rebuilt "${name}" — removed: ${res.removed.join(', ') || '(nothing to remove)'}`)
  out(res.keptPlugins ? 'Plugins kept.' : 'Plugins wiped.')
}

function cmdReveal(positional) {
  const name = requireName(positional, 'reveal')
  out(`Opening ${manage.reveal(name)}`)
}

function cmdLaunchers(positional) {
  // Backfills instances made before launchers existed, and repairs them if mcctl moves on disk -
  // the .bat files hold an absolute path to the CLI.
  const targets = positional.length ? positional.map(getInstance) : listInstances()
  for (const inst of targets) {
    const files = create.writeLaunchers(inst)
    out(`${inst.name}: ${files.join(', ')}`)
  }
  out('')
  out('Double-click start.bat in an instance folder to run it with a console attached.')
}

async function cmdUi(positional, flags) {
  const { url } = await ui.serve({
    port: Number(flags.port ?? 8770),
    open: !flags.noOpen,
  })
  out(`mcctl panel: ${url}`)
  out('Bound to 127.0.0.1 only — it can start servers and type console commands, so it is')
  out('for this machine, not the network. Ctrl+C to stop the panel (servers keep running).')
}

async function cmdPaper(positional, flags) {
  const sub = positional[0] ?? 'versions'

  if (sub === 'versions') {
    const all = await paper.versions({ includeUnstable: Boolean(flags.unstable) })
    const limit = Number(flags.limit ?? 25)
    out(`Paper versions (newest first)${flags.unstable ? ', including pre-releases' : ''}:`)
    out('  ' + all.slice(0, limit).join('  '))
    if (all.length > limit) out(`  ... ${all.length - limit} older (use --limit ${all.length})`)
    return
  }

  if (sub === 'builds') {
    const version = positional[1]
    if (!version) fail('usage: mcctl paper builds <version>')
    const all = await paper.builds(version)
    const rows = [['BUILD', 'CHANNEL', 'DATE', 'FILE']]
    for (const b of all.slice(0, Number(flags.limit ?? 15))) {
      rows.push([String(b.build), b.channel, b.time.slice(0, 10), b.name ?? '-'])
    }
    out(table(rows))
    return
  }

  if (sub === 'fetch') {
    const version = positional[1]
    if (!version) fail('usage: mcctl paper fetch <version> [build] [--force]')
    const res = await paper.fetchBuild(version, positional[2] ?? null, { force: Boolean(flags.force) })
    if (res.cached) {
      out(`Already stored: ${res.name} (build ${res.build}, ${res.channel}). Re-download with --force.`)
    } else {
      out(`Downloaded ${res.name} — build ${res.build}, ${res.channel}, ${res.sizeHuman}, checksum verified.`)
    }
    out(`Use it with: mcctl new <name> --jar ${res.name}`)
    return
  }

  fail('usage: mcctl paper [versions|builds <version>|fetch <version> [build]]')
}

function cmdJars(positional, flags) {
  const sub = positional[0]
  if (sub === 'import') {
    const src = positional[1]
    if (!src) fail('usage: mcctl jars import <path-to-jar> [--as <name>]')
    const dest = create.importJar(src, { as: flags.as ?? null })
    out(`Imported ${dest}`)
    return
  }
  const jars = create.listJars()
  if (!jars.length) {
    out('No jars stored. Import one with: mcctl jars import <path-to-jar>')
    return
  }
  const rows = [['NAME', 'SIZE', 'ADDED']]
  for (const j of jars) rows.push([j.name, j.sizeHuman, j.mtime.toISOString().slice(0, 10)])
  out(table(rows))
}

// -------------------------------------------------------------------- doctor

/**
 * Scheduled tasks.
 *
 * <p>`task run` is what Windows Task Scheduler actually invokes, through a small batch file, and it
 * is the only thing a trigger is able to call. What a task DOES comes from its stored definition
 * rather than from the command line, so a scheduled task can only ever be one of the handful of
 * things mcctl allows a task to be - not a way to run whatever was written into a trigger.
 */
async function cmdTask(positional, flags) {
  const sub = positional[0] ?? 'list'

  if (sub === 'list') {
    const tasks = schedule.list()
    if (!tasks.length) {
      out('No scheduled tasks.')
      out('')
      out('  Add one with: mcctl task add <instance> --do backup --daily 03:00')
      return
    }
    const rows = [['ID', 'INSTANCE', 'DOES', 'WHEN', 'STATE', 'LAST', 'NEXT']]
    for (const t of tasks) {
      const w = t.windows
      rows.push([
        t.id,
        t.instance,
        t.action.type,
        describeSchedule(t.schedule),
        t.enabled ? (w ? w.state : 'NOT IN SCHEDULER') : 'disabled',
        w ? schedule.describeResult(w.lastResult) : '-',
        w?.nextRun ? String(w.nextRun).replace('T', ' ').slice(0, 16) : '-',
      ])
    }
    out(table(rows))
    out('')
    out('Tasks run while you are logged in, including with the screen locked - not after signing out.')
    return
  }

  if (sub === 'run') {
    const id = positional[1]
    if (!id) fail('usage: mcctl task run <id>')
    return runTask(id)
  }

  if (sub === 'add') {
    const instance = positional[1]
    if (!instance) fail('usage: mcctl task add <instance> --do <backup|command|restart|stop|start> [when]')
    getInstance(instance)
    const type = String(flags.do ?? 'backup')
    const action = { type }
    if (type === 'command') {
      if (!flags.line) fail('--do command needs --line "<what to send>"')
      action.line = String(flags.line)
    }
    const sched = flags.hourly ? { kind: 'hourly', every: Number(flags.hourly) || 1 }
      : flags.minutes ? { kind: 'minutes', every: Number(flags.minutes) || 30 }
      : flags.weekly ? { kind: 'weekly', day: String(flags.weekly), at: String(flags.at ?? '03:00') }
      : flags.onLogon ? { kind: 'onlogon' }
      : { kind: 'daily', at: String(flags.daily === true ? '03:00' : flags.daily ?? flags.at ?? '03:00') }
    const made = schedule.create({ instance, name: flags.name ?? null, action, schedule: sched })
    out(`Created "${made.id}" - ${made.name}, ${describeSchedule(made.schedule)}.`)
    return
  }

  if (sub === 'rm') {
    const id = positional[1]
    if (!id) fail('usage: mcctl task rm <id>')
    schedule.remove(id)
    out(`Removed "${id}".`)
    return
  }

  if (sub === 'enable' || sub === 'disable') {
    const id = positional[1]
    if (!id) fail(`usage: mcctl task ${sub} <id>`)
    schedule.setEnabled(id, sub === 'enable')
    out(`${sub === 'enable' ? 'Enabled' : 'Disabled'} "${id}".`)
    return
  }

  fail('usage: mcctl task [list|add|run|rm|enable|disable]')
}

function describeSchedule(s) {
  switch (s.kind) {
    case 'hourly': return s.every > 1 ? `every ${s.every}h` : 'hourly'
    case 'minutes': return `every ${s.every}m`
    case 'weekly': return `${s.day} ${s.at}`
    case 'onlogon': return 'at logon'
    default: return `daily ${s.at}`
  }
}

/**
 * Perform one scheduled task.
 *
 * <p>Runs unattended, so everything it does is written down: Task Scheduler records the exit code,
 * and stdout goes to the instance's own run directory where the panel can show it next to the task
 * that produced it. A failure at 3am that leaves no trace is the reason to bother.
 */
async function runTask(id) {
  const all = schedule.load().tasks
  if (!Object.hasOwn(all, id)) fail(`no scheduled task "${id}"`)
  const task = all[id]
  const { instance, action } = task
  const started = Date.now()

  const record = (ok, detail) => {
    const line = `${new Date().toISOString()}\t${ok ? 'ok' : 'FAILED'}\t${action.type}\t${detail}`
    try {
      const file = path.join(runDir(instance), 'tasks.log')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, line + '\n')
    } catch {
      /* the exit code still reaches Task Scheduler */
    }
    out(line)
  }

  try {
    const inst = getInstance(instance)
    const running = sup.isRunning(instance)

    if (action.type === 'backup') {
      const res = await backup.createSnapshot(inst, { scope: 'standard', label: 'scheduled', running })
      let pruned = ''
      // Pruned AFTER the new one exists, never before: trimming first would mean a failed backup
      // leaves you with fewer than you had, which is the opposite of what a retention limit is for.
      if (Number.isInteger(action.keep) && action.keep > 0) {
        const gone = backup.pruneSnapshots(instance, action.keep)
        if (gone.length) pruned = `, pruned ${gone.length} over the limit of ${action.keep}`
      }
      record(true, `${res.file} (${humanBytes(res.size)})${pruned}`)
    } else if (action.type === 'command') {
      if (!running) return record(false, 'server is not running')
      await sup.sendConsole(instance, action.line)
      record(true, action.line)
    } else if (action.type === 'restart') {
      if (running) await sup.stop(instance)
      await sup.start(instance, { wait: false })
      record(true, 'restarted')
    } else if (action.type === 'stop') {
      if (!running) return record(true, 'already stopped')
      await sup.stop(instance)
      record(true, 'stopped')
    } else if (action.type === 'start') {
      if (running) return record(true, 'already running')
      await sup.start(instance, { wait: false })
      record(true, 'started')
    } else {
      fail(`unknown action "${action.type}"`)
    }
  } catch (err) {
    record(false, err?.message ?? String(err))
    process.exitCode = 1
    return
  }
  out(`done in ${Math.round((Date.now() - started) / 1000)}s`)
}

async function cmdDoctor() {
  const problems = []
  const notes = []

  // The same probe the panel and the first-run wizard use, so all three agree about what
  // counts as a usable Java.
  const javaCheck = java.probe()
  if (!javaCheck.ok) problems.push(`java: ${javaCheck.message} ${java.DOWNLOAD_URL}`)
  else notes.push(`java: ${javaCheck.version}`)

  const tarCheck = spawnSync('tar', ['--version'], { encoding: 'utf8', windowsHide: true })
  if (tarCheck.error) problems.push('tar is not on PATH (needed for snapshots)')
  else notes.push(`tar: ${(tarCheck.stdout || '').split('\n')[0].trim()}`)

  notes.push(`node: ${process.version}`)
  notes.push(`root: ${ROOT}`)

  const seenPorts = new Map()
  for (const inst of listInstances()) {
    if (!fs.existsSync(inst.dir)) {
      problems.push(`${inst.name}: directory missing (${inst.dir})`)
      continue
    }
    if (!fs.existsSync(serverJarPath(inst))) {
      problems.push(`${inst.name}: jar missing (${serverJarPath(inst)})`)
    }
    const eula = path.join(inst.dir, 'eula.txt')
    const eulaText = fs.existsSync(eula) ? fs.readFileSync(eula, 'utf8') : ''
    if (!/^\s*eula\s*=\s*true\s*$/im.test(eulaText)) {
      problems.push(`${inst.name}: EULA not accepted (${eula})`)
    }
    for (const [label, port] of [['port', inst.port], ['rcon', inst.rcon?.port]]) {
      if (!port) continue
      if (seenPorts.has(port)) problems.push(`${inst.name}: ${label} ${port} collides with ${seenPorts.get(port)}`)
      else seenPorts.set(port, `${inst.name} ${label}`)
    }
    const { status } = readState(inst.name)
    if (status === 'orphaned') problems.push(`${inst.name}: orphaned java process - run "mcctl kill ${inst.name}"`)
    if (status === 'stale') {
      clearState(inst.name)
      notes.push(`${inst.name}: cleared stale state file`)
    }
    if (status === 'stopped') {
      const free = await isPortFree(inst.port)
      if (!free) problems.push(`${inst.name}: port ${inst.port} is in use by something else while the instance is stopped`)
    }
    notes.push(`${inst.name}: ${humanBytes(dirSize(inst.dir))} on disk at ${inst.dir}`)
  }

  out('Environment')
  for (const n of notes) out(`  ${n}`)
  out('')
  if (!problems.length) {
    out('No problems found.')
    return
  }
  out(`${problems.length} problem(s):`)
  for (const p of problems) out(`  - ${p}`)
  process.exitCode = 1
}

// ---------------------------------------------------------------------- help

function cmdHelp() {
  out(`mcctl - local Minecraft server control plane

LIFECYCLE
  mcctl list                         Show every instance and its state
  mcctl status <name>                Detailed state for one instance
  mcctl start <name>                 Start and wait until the server reports ready
      --detach                       Return as soon as the process launches
      --timeout <sec>                Ready timeout (default 180)
      --no-sync                      Do not push registry ports into server.properties
  mcctl stop <name> [--timeout sec]  Graceful shutdown via the console "stop" command
  mcctl restart <name>               Stop then start
  mcctl kill <name>                  Force-kill the process tree

CONSOLE
  mcctl logs <name> [-n 60] [-f]     Read the captured console; -f follows
      --grep <regex>                 Filter lines
  mcctl cmd <name> "<command>"       Run a command over RCON and print the reply
  mcctl send <name> "<line>"         Write a raw line to the server's stdin
  mcctl console <name>               Interactive attach (server survives detach)
  mcctl players <name>               Who is online

INSTANCES
  mcctl adopt <name> <dir>           Register an existing server directory in place
      --jar <file> --memory <4G>
  mcctl new <name> [options]         Create a fresh instance
      --jar <file>                   Server jar from the jars/ store
      --paper <version>              Download that Paper version and use it
      --template <name>              Start from a saved template
      --memory <4G> --port <n>
      --accept-eula                  Write eula=true (you accept Mojang's EULA)
      --offline                      Let anyone join as any name, no account needed.
                                     Puts an OFFLINE/INSECURE banner in every log.
  mcctl clone <src> <new>            Copy plugins+config into a new instance
      --with-worlds                  Also copy world data (default: fresh worlds)
  mcctl set <name> key=value...      memory, java, jar, port, rcon.port, rcon.password
  mcctl props <name> [key=value...]  Read or edit server.properties
  mcctl rm <name> [--purge --yes]    Unregister (and optionally delete files)

SNAPSHOTS
  mcctl backup <name>                Snapshot to backups/<name>/
      --scope <${backup.SCOPES.join('|')}>
      --label <text> --keep <n>
  mcctl snapshots <name>             List snapshots
  mcctl restore <name> [ref] --yes   Restore (default ref: latest); server must be stopped
  mcctl prune <name> --keep <n>      Delete all but the newest n

OTHER
  mcctl templates                    List templates
  mcctl templates save <inst> <tpl>  Save an instance's plugins+config as a template
  mcctl ui                           Open the local control panel in a browser
  mcctl paper versions               Paper versions available to download
  mcctl paper fetch <version>        Download a Paper build into the jar store
  mcctl config                       Show where servers, jars and backups live
  mcctl config set-root <path>       Move the data root (new servers only)
  mcctl config set-instances <path>  Put servers on a different drive
  mcctl rename <old> <new>           Rename an instance (and its folder)
  mcctl rebuild <name> --yes         Reset worlds; keeps plugins unless --wipe-plugins
  mcctl reveal <name>                Open the instance folder in Explorer
  mcctl launchers [name]             Write start/console/stop .bat files
  mcctl jars                         List stored server jars
  mcctl jars import <path> [--as x]  Add a server jar to the store
  mcctl doctor                       Check environment, ports, EULA, disk, stale state
`)
}

// ---------------------------------------------------------------------- main

const COMMANDS = {
  list: cmdList,
  ls: cmdList,
  status: cmdStatus,
  start: cmdStart,
  stop: cmdStop,
  restart: cmdRestart,
  kill: cmdKill,
  logs: cmdLogs,
  log: cmdLogs,
  cmd: cmdCmd,
  rcon: cmdCmd,
  send: cmdSend,
  console: cmdConsole,
  attach: cmdConsole,
  players: cmdPlayers,
  new: cmdNew,
  clone: cmdClone,
  adopt: cmdAdopt,
  rm: cmdRemove,
  remove: cmdRemove,
  set: cmdSet,
  props: cmdProps,
  backup: cmdBackup,
  snapshot: cmdBackup,
  snapshots: cmdSnapshots,
  restore: cmdRestore,
  prune: cmdPrune,
  templates: cmdTemplates,
  template: cmdTemplates,
  jars: cmdJars,
  paper: cmdPaper,
  config: cmdConfig,
  rename: cmdRename,
  rebuild: cmdRebuild,
  reveal: cmdReveal,
  open: cmdReveal,
  launchers: cmdLaunchers,
  ui: cmdUi,
  panel: cmdUi,
  task: cmdTask,
  doctor: cmdDoctor,
  help: cmdHelp,
}

async function main() {
  ensureDirs()
  const [, , command, ...rest] = process.argv
  if (!command || command === '--help' || command === '-h') {
    cmdHelp()
    return
  }
  const handler = COMMANDS[command]
  if (!handler) {
    process.stderr.write(`Unknown command "${command}". Run "mcctl help" for usage.\n`)
    process.exitCode = 2
    return
  }
  const { flags, positional } = parseArgs(rest)
  await handler(positional, flags)
}

main().catch((err) => {
  if (err instanceof UserError) {
    process.stderr.write(`error: ${err.message}\n`)
    process.exitCode = 1
  } else {
    process.stderr.write(`${err.stack || err}\n`)
    process.exitCode = 1
  }
})
