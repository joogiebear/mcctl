import fs from 'node:fs'
import path from 'node:path'
import { JARS_DIR, TEMPLATES_DIR, INSTANCES_DIR, ROOT } from './paths.mjs'
import { getInstance, hasInstance, putInstance, usedPorts, defaultDir } from './registry.mjs'
import { readProps, writeProps } from './props.mjs'
import { fail, findFreePort, randomPassword, validateName, humanBytes } from './util.mjs'

const DEFAULT_PORT = 25565
const DEFAULT_RCON_PORT = 25575

export function listJars() {
  fs.mkdirSync(JARS_DIR, { recursive: true })
  return fs
    .readdirSync(JARS_DIR)
    .filter((f) => f.endsWith('.jar'))
    .map((f) => {
      const st = fs.statSync(path.join(JARS_DIR, f))
      return { name: f, size: st.size, sizeHuman: humanBytes(st.size), mtime: st.mtime }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function importJar(src, { as = null } = {}) {
  if (!fs.existsSync(src)) fail(`jar not found: ${src}`)
  fs.mkdirSync(JARS_DIR, { recursive: true })
  const dest = path.join(JARS_DIR, as || path.basename(src))
  fs.copyFileSync(src, dest)
  return dest
}

/**
 * Double-clickable launchers, written into each instance directory.
 *
 * <p>Not everything wants a terminal and a remembered command. These make an instance startable and
 * watchable from Explorer, which is also what makes a second machine or a second person able to run
 * one of these servers without learning the CLI first.
 *
 * <p>They shell out to mcctl by absolute path rather than duplicating any logic, so a launcher can
 * never drift from what the CLI actually does - it IS the CLI.
 */
export function writeLaunchers(inst) {
  const cli = path.join(ROOT, 'mcctl.mjs')
  const files = {
    // Starts, then attaches - so a double-click gives you a running server AND its console, which is
    // what "start the server" means to anyone not thinking about daemons.
    'start.bat': `@echo off
title ${inst.name} - mcctl
node "${cli}" start ${inst.name}
if errorlevel 1 (echo.& echo Failed to start. & pause & exit /b 1)
node "${cli}" console ${inst.name}
`,
    'console.bat': `@echo off
title ${inst.name} console - mcctl
node "${cli}" console ${inst.name}
pause
`,
    'stop.bat': `@echo off
title ${inst.name} - mcctl
node "${cli}" stop ${inst.name}
pause
`,
  }
  for (const [file, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(inst.dir, file), body)
  }
  return Object.keys(files)
}

export function listTemplates() {
  fs.mkdirSync(TEMPLATES_DIR, { recursive: true })
  return fs
    .readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const metaFile = path.join(TEMPLATES_DIR, e.name, 'template.json')
      let meta = {}
      try {
        meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
      } catch {
        /* templates without metadata are still usable */
      }
      return { name: e.name, dir: path.join(TEMPLATES_DIR, e.name), ...meta }
    })
}

function copyTree(src, dest, { skip = new Set() } = {}) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyTree(s, d, { skip })
    else if (entry.isFile()) fs.copyFileSync(s, d)
  }
}

/** Everything that must never be cloned between instances. */
const CLONE_SKIP = new Set([
  'cache',
  'libraries',
  'versions',
  'logs',
  'server-console.log',
  'usercache.json',
  'version_history.json',
  'session.lock',
])

async function allocatePorts({ port, rconPort }) {
  const taken = usedPorts()
  const resolvedPort = port ?? (await findFreePort(DEFAULT_PORT, taken))
  taken.add(resolvedPort)
  const resolvedRcon = rconPort ?? (await findFreePort(DEFAULT_RCON_PORT, taken))
  return { port: resolvedPort, rconPort: resolvedRcon }
}

export async function newInstance(
  name,
  {
    template = null,
    from = null,
    withWorlds = false,
    jar = null,
    memory = '4G',
    port = null,
    rconPort = null,
    acceptEula = false,
    motd = null,
    java = 'java',
  } = {},
) {
  validateName(name)
  if (hasInstance(name)) fail(`instance "${name}" already exists`)

  const dir = defaultDir(name)
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
    fail(`directory already exists and is not empty: ${dir}`)
  }
  fs.mkdirSync(dir, { recursive: true })

  let sourceJar = null

  if (from) {
    const src = getInstance(from)
    if (!fs.existsSync(src.dir)) fail(`source instance directory is missing: ${src.dir}`)
    const skip = new Set(CLONE_SKIP)
    if (!withWorlds) {
      const props = readProps(path.join(src.dir, 'server.properties'))
      const level = props.get('level-name') || 'world'
      for (const entry of fs.readdirSync(src.dir, { withFileTypes: true })) {
        if (entry.isDirectory() && (entry.name === level || entry.name.startsWith(`${level}_`))) {
          skip.add(entry.name)
        }
      }
    }
    copyTree(src.dir, dir, { skip })
    sourceJar = src.jar
    memory = memory ?? src.memory
  } else if (template) {
    const tpl = listTemplates().find((t) => t.name === template)
    if (!tpl) fail(`no template named "${template}" - see: mcctl templates`)
    copyTree(tpl.dir, dir, { skip: new Set(['template.json']) })
    sourceJar = tpl.jar ?? null
  }

  // Resolve the server jar and place it in the instance directory.
  const chosenJar = jar ?? sourceJar
  if (!chosenJar) {
    fail(
      `no server jar specified.\n` +
        `  Pick one with --jar <file>. Available: ${listJars().map((j) => j.name).join(', ') || '(none - use "mcctl jars import <path>")'}`,
    )
  }
  const jarInInstance = path.join(dir, path.basename(chosenJar))
  if (!fs.existsSync(jarInInstance)) {
    const fromStore = path.join(JARS_DIR, path.basename(chosenJar))
    const abs = path.isAbsolute(chosenJar) ? chosenJar : null
    const src = fs.existsSync(fromStore) ? fromStore : abs && fs.existsSync(abs) ? abs : null
    if (!src) {
      fail(
        `server jar "${chosenJar}" not found in ${JARS_DIR}.\n` +
          `  Import one with: mcctl jars import <path-to-jar>`,
      )
    }
    fs.copyFileSync(src, jarInInstance)
  }

  const { port: finalPort, rconPort: finalRcon } = await allocatePorts({ port, rconPort })
  const rconPassword = randomPassword()

  const props = {
    'server-port': String(finalPort),
    'enable-rcon': 'true',
    'rcon.port': String(finalRcon),
    'rcon.password': rconPassword,
    'server-ip': '',
    'online-mode': 'false',
    'motd': motd ?? `${name} (mcctl)`,
    'max-players': '10',
    'spawn-protection': '0',
  }
  writeProps(path.join(dir, 'server.properties'), props)

  if (acceptEula) {
    fs.writeFileSync(
      path.join(dir, 'eula.txt'),
      `# Accepted via mcctl on ${new Date().toISOString()}\n` +
        `# https://aka.ms/MinecraftEULA\neula=true\n`,
    )
  }

  const cfg = {
    dir,
    jar: path.basename(chosenJar),
    java,
    memory,
    port: finalPort,
    rcon: { port: finalRcon, password: rconPassword },
    createdAt: new Date().toISOString(),
    origin: from ? { clonedFrom: from, withWorlds } : template ? { template } : { scratch: true },
  }
  putInstance(name, cfg)
  writeLaunchers({ name, dir: cfg.dir })
  return { name, ...cfg, eulaAccepted: acceptEula }
}

/**
 * Register an existing server directory without moving or rewriting it.
 * Ports and RCON credentials are read from its own server.properties so the
 * adopted server keeps behaving exactly as it did before.
 */
export async function adoptInstance(name, dir, { jar = null, memory = '4G', java = 'java' } = {}) {
  validateName(name)
  if (hasInstance(name)) fail(`instance "${name}" already exists`)
  const abs = path.resolve(dir)
  if (!fs.existsSync(abs)) fail(`directory not found: ${abs}`)

  const jars = fs
    .readdirSync(abs)
    .filter((f) => f.endsWith('.jar'))
    .sort()
  let chosen = jar
  if (!chosen) {
    const preferred = jars.filter((f) => /paper|purpur|spigot|folia|fabric|server/i.test(f))
    const pool = preferred.length ? preferred : jars
    if (pool.length === 0) fail(`no .jar found in ${abs} - pass --jar <file>`)
    if (pool.length > 1) fail(`multiple jars in ${abs} - pass --jar <one of: ${pool.join(', ')}>`)
    chosen = pool[0]
  }
  if (!fs.existsSync(path.join(abs, chosen))) fail(`jar not found: ${path.join(abs, chosen)}`)

  const props = readProps(path.join(abs, 'server.properties'))
  const taken = usedPorts()
  const port = Number(props.get('server-port')) || (await findFreePort(DEFAULT_PORT, taken))
  taken.add(port)
  const rconPort = Number(props.get('rcon.port')) || (await findFreePort(DEFAULT_RCON_PORT, taken))
  const rconPassword = props.get('rcon.password') || randomPassword()

  const cfg = {
    dir: abs,
    jar: chosen,
    java,
    memory,
    port,
    rcon: { port: rconPort, password: rconPassword },
    createdAt: new Date().toISOString(),
    origin: { adopted: abs },
  }
  putInstance(name, cfg)
  writeLaunchers({ name, dir: cfg.dir })
  return { name, ...cfg }
}

/** Snapshot an instance's plugins+config into a reusable template. */
export function saveTemplate(inst, templateName, { includeWorlds = false } = {}) {
  validateName(templateName)
  const dest = path.join(TEMPLATES_DIR, templateName)
  if (fs.existsSync(dest)) fail(`template "${templateName}" already exists`)

  const skip = new Set(CLONE_SKIP)
  if (!includeWorlds) {
    const props = readProps(path.join(inst.dir, 'server.properties'))
    const level = props.get('level-name') || 'world'
    for (const entry of fs.readdirSync(inst.dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === level || entry.name.startsWith(`${level}_`))) {
        skip.add(entry.name)
      }
    }
  }
  // The jar lives in jars/, not inside every template copy.
  skip.add(inst.jar)

  copyTree(inst.dir, dest, { skip })
  fs.writeFileSync(
    path.join(dest, 'template.json'),
    `${JSON.stringify(
      {
        name: templateName,
        jar: inst.jar,
        memory: inst.memory,
        includesWorlds: includeWorlds,
        sourceInstance: inst.name,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  )
  return { name: templateName, dir: dest }
}

export { INSTANCES_DIR }
