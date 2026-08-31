'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/**
 * The only bridge between the page and the machine.
 *
 * Three named calls, nothing generic. A preload that forwards arbitrary IPC would hand the page the
 * whole main process, and the page is a local web app that also runs in an ordinary browser — it
 * should be able to do exactly as much in one as the other, plus these.
 */
contextBridge.exposeInMainWorld('mcctlDesktop', {
  /** True when running inside the app rather than a browser tab, so the page can adapt. */
  isDesktop: true,

  /** Native folder chooser. Resolves to an absolute path, or null if cancelled. */
  pickFolder: (title) => ipcRenderer.invoke('mcctl:pickFolder', { title }),

  /** Current and default locations, for the setup screen. */
  getSetup: () => ipcRenderer.invoke('mcctl:getSetup'),

  /** Save locations and restart into them. */
  saveSetup: (choice) => ipcRenderer.invoke('mcctl:saveSetup', choice),
})
