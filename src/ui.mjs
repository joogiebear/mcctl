import http from 'node:http'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as supervisor from './supervisor.mjs'
import * as registry from './registry.mjs'
import * as create from './create.mjs'
import * as paper from './paper.mjs'

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
      const url = `http://${host}:${port}/`
      if (open) openBrowser(url)
      resolve({ server, url })
    })
  })
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

  if (seg[1] === 'instances' && req.method === 'POST' && seg.length === 2) {
    const body = await readBody(req)
    if (!body.name) return json(res, 400, { error: 'name is required' })
    let jar = body.jar || null
    if (body.paperVersion) {
      const build = await paper.fetchBuild(String(body.paperVersion), null)
      jar = build.name
    }
    const inst = await create.newInstance(String(body.name), {
      jar,
      memory: body.memory || '4G',
      port: body.port ? Number(body.port) : null,
      motd: body.motd || null,
      // The panel is local and the person clicking Create is the operator; making them re-accept
      // the EULA in a second place would be ceremony, not consent.
      acceptEula: true,
    })
    return json(res, 200, inst)
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
