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
  // Read-only. Changing the data root means re-resolving paths that are fixed at import, so the
  // panel shows the layout and says how to move it rather than pretending it can move it live.
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
      const { rcon, ...safe } = row
      return { ...safe, rconPort: rcon?.port ?? null }
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
    const { rcon, ...safe } = inst
    return json(res, 200, safe)
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
        // The panel is local and the person clicking Create is the operator; making them re-accept
        // the EULA in a second place would be ceremony, not consent.
        acceptEula: true,
      })
      jobUpdate(jobId, { stage: 'done', percent: 100, message: `Created ${inst.name}`, done: true })
      const { rcon, ...safe } = inst
      return json(res, 200, safe)
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

  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

  if (seg[3] === 'start') {
    await supervisor.start(name)
    return json(res, 200, supervisor.statusOf(name))
  }
  if (seg[3] === 'stop') {
    await supervisor.stop(name)
    return json(res, 200, supervisor.statusOf(name))
  }
  if (seg[3] === 'restart') {
    await supervisor.stop(name).catch(() => {})
    await supervisor.start(name)
    return json(res, 200, supervisor.statusOf(name))
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
    if (body.memory) patch.memory = String(body.memory)
    if (body.port) patch.port = Number(body.port)
    if (body.jar) patch.jar = String(body.jar)
    if (body.java) patch.java = String(body.java)
    registry.updateInstance(name, patch)
    return json(res, 200, supervisor.statusOf(name))
  }
  if (seg[3] === 'command') {
    const body = await readBody(req)
    if (!body.line) return json(res, 400, { error: 'line is required' })
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
