'use strict'

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

/**
 * mcctl desktop.
 *
 * A window around the same panel the CLI serves, plus the two things a browser cannot do: a native
 * folder picker, and a first-run setup that happens before anything exists.
 *
 * The core runs IN THIS PROCESS rather than as a spawned server. Electron already is a Node
 * runtime, so importing mcctl directly is what "bundled" actually means here - one process, no
 * second Node to ship, and no orphaned child if the window dies.
 */

/**
 * Where the mcctl core lives.
 *
 * Packaged: alongside the app in resources. Development: the checkout, so the app under test is the
 * code being edited rather than a copy that drifts from it.
 *
 *   npm start -- --core S:\Claude\mcctl        (or set MCCTL_CORE)
 */
function resolveCore() {
  const flagIndex = process.argv.indexOf('--core')
  const fromFlag = flagIndex !== -1 ? process.argv[flagIndex + 1] : null
  const dev = fromFlag || process.env.MCCTL_CORE
  if (dev) return { dir: path.resolve(dev), mode: 'dev' }

  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, 'core')
    : path.resolve(__dirname, '..')
  return { dir: bundled, mode: app.isPackaged ? 'bundled' : 'checkout' }
}

const core = resolveCore()

/** Import an ESM module out of the resolved core by file URL, so the path can vary at runtime. */
function loadCore(rel) {
  return import(pathToFileURL(path.join(core.dir, rel)).href)
}

let panelUrl = null
let win = null

async function startPanel() {
  const ui = await loadCore('src/ui.mjs')
  // Port 0: let the OS pick. A fixed port would collide with a CLI panel already running, and the
  // desktop app has no reason to be reachable at a predictable address.
  const { url } = await ui.serve({ port: 0, host: '127.0.0.1', open: false })
  return url
}

/** Whether the first-run wizard should be shown: nothing configured, and no existing layout found. */
async function needsSetup() {
  const settings = await loadCore('src/settings.mjs')
  const saved = settings.load()
  if (saved.dataRoot) return false
  // An existing checkout already holding instances.json is a configured install in all but name;
  // asking that person where to put their servers would be asking about servers they already have.
  return !fs.existsSync(path.join(core.dir, 'instances.json'))
}

function createWindow(loadUrl) {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#10131a',
    title: 'mcctl',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // The page is local and trusted, but there is no reason for it to hold Node: everything it
      // needs comes through preload as three named calls.
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  win.loadURL(loadUrl)

  // Links to anywhere else belong in the real browser, not in a chrome-less app window the person
  // cannot navigate back out of.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  return win
}

// ---- IPC: the things a web page cannot do for itself -------------------------

ipcMain.handle('mcctl:pickFolder', async (_e, { title } = {}) => {
  const res = await dialog.showOpenDialog(win, {
    title: title || 'Choose a folder',
    // createDirectory lets someone make the folder in the dialog instead of alt-tabbing to
    // Explorer to make it and coming back.
    properties: ['openDirectory', 'createDirectory'],
  })
  return res.canceled ? null : res.filePaths[0]
})

ipcMain.handle('mcctl:getSetup', async () => {
  const settings = await loadCore('src/settings.mjs')
  const roots = settings.resolveRoots()
  return {
    defaultDataRoot: settings.defaultDataRoot(),
    current: roots,
    coreDir: core.dir,
    coreMode: core.mode,
  }
})

ipcMain.handle('mcctl:saveSetup', async (_e, { dataRoot, instancesDir, separate }) => {
  const settings = await loadCore('src/settings.mjs')

  // Written to, not merely inspected. A drive that has been unplugged, a read-only mount and a
  // network share all look fine until the first write.
  for (const dir of [dataRoot, separate ? instancesDir : null].filter(Boolean)) {
    const check = settings.checkWritable(dir)
    if (!check.ok) return { ok: false, error: `Cannot write to ${dir}\n${check.error}` }
  }

  settings.save({
    dataRoot,
    separateInstances: Boolean(separate),
    instancesDir: separate ? instancesDir : null,
  })

  // The core resolves its locations once at import, so the new layout only takes effect on a fresh
  // start. Relaunching is honest about that rather than leaving a half-configured process running.
  app.relaunch({ args: process.argv.slice(1) })
  app.exit(0)
  return { ok: true }
})

// ---- lifecycle ---------------------------------------------------------------

app.whenReady().then(async () => {
  if (await needsSetup()) {
    createWindow(pathToFileURL(path.join(__dirname, 'setup.html')).href)
  } else {
    panelUrl = await startPanel()
    createWindow(panelUrl)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(panelUrl)
  })
})

app.on('window-all-closed', () => {
  // Closing the window closes the app, but the SERVERS keep running: mcctl starts each one as a
  // detached daemon that does not belong to this process. Quitting a control panel must never take
  // a running Minecraft server down with it.
  if (process.platform !== 'darwin') app.quit()
})
