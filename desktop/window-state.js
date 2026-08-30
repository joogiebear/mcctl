'use strict'

const fs = require('node:fs')
const path = require('node:path')

/**
 * Remembering where the window was.
 *
 * <p>Its own module because the interesting part is not the storing, it is deciding whether a
 * remembered position is still somewhere a person can reach - and that is worth being able to test
 * on its own, without launching an application to find out.
 */

const DEFAULT_BOUNDS = { width: 1280, height: 820 }
const MIN_WIDTH = 900
const MIN_HEIGHT = 600

/**
 * Is this rectangle somewhere a person could actually see?
 *
 * <p>The classic way to lose a window is to restore it onto a monitor that is no longer attached:
 * the app launches, reports itself running, and paints at x=-1920 where nobody will ever find it.
 * A saved position is honoured only when a usable part of it lands inside some display's work
 * area - enough of the title bar to grab, not merely a pixel of contact. Otherwise the position is
 * dropped and the window is centred.
 *
 * <p>`displays` is passed in rather than read from Electron so this can be checked against
 * arrangements that are not plugged into the machine running the test.
 */
function isVisibleSomewhere(bounds, displays) {
  return displays.some((area) => {
    const overlapX = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
    const overlapY = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y)
    return overlapX > 120 && overlapY > 40
  })
}

/** Read the saved state, discarding anything that is not usable on the displays we have now. */
function load(file, displays) {
  let saved = null
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    // Missing, or written by something that is not this. Either way, defaults.
    return { ...DEFAULT_BOUNDS, maximized: false }
  }

  const width = Math.max(MIN_WIDTH, Math.round(Number(saved.width) || DEFAULT_BOUNDS.width))
  const height = Math.max(MIN_HEIGHT, Math.round(Number(saved.height) || DEFAULT_BOUNDS.height))
  const state = { width, height, maximized: saved.maximized === true }

  if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const at = { x: Math.round(saved.x), y: Math.round(saved.y), width, height }
    if (isVisibleSomewhere(at, displays)) {
      state.x = at.x
      state.y = at.y
    }
  }
  return state
}

/**
 * Follow a window and record where it ends up.
 *
 * <p>Written on a short delay rather than on every event, because dragging emits a move per frame
 * and none of them are the answer - only the one where the person stopped. Maximised is stored
 * separately from the bounds, and getNormalBounds is what gets saved, so un-maximising later
 * restores the size the window had before rather than the size of the screen.
 */
function track(win, file) {
  let timer = null

  const save = () => {
    if (!win || win.isDestroyed()) return
    const normal = win.getNormalBounds()
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const state = {
        x: normal.x,
        y: normal.y,
        width: normal.width,
        height: normal.height,
        maximized: win.isMaximized(),
      }
      fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n')
    } catch {
      // Losing the remembered position is a smaller problem than failing to close.
    }
  }

  const later = () => {
    clearTimeout(timer)
    timer = setTimeout(save, 400)
  }

  for (const event of ['resize', 'move', 'maximize', 'unmaximize']) win.on(event, later)
  // 'close', not 'closed': the window still has bounds to read at this point.
  win.on('close', () => {
    clearTimeout(timer)
    save()
  })
}

module.exports = { load, track, isVisibleSomewhere, DEFAULT_BOUNDS, MIN_WIDTH, MIN_HEIGHT }
