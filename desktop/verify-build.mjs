#!/usr/bin/env node
/**
 * Check that a build actually came out the way it is supposed to.
 *
 * <p>There is no CI on this repository, so the only thing standing between a broken build and a
 * published release is a check that runs on the machine doing the building. These are the things
 * that have silently gone wrong before, each of which produces an artifact that looks completely
 * normal until someone installs it:
 *
 * <ul>
 *   <li>The icon not reaching the executable. electron-builder applies it with rcedit, which lives
 *       in a toolchain it downloads on first use; if that extraction fails - it needs permission to
 *       create symlinks, which Windows withholds unless Developer Mode is on - the build carries on
 *       and ships Electron's default atom.</li>
 *   <li>The core not being copied into resources, which makes the app start and then fail at the
 *       first thing it tries to do.</li>
 *   <li>src/ui.html missing, which is the entire panel.</li>
 * </ul>
 *
 * <p>Called from the afterPack hook during a build (structure only, because the icon is applied
 * after that hook runs) and again by `npm run verify` on the finished artifact. Zero dependencies,
 * like everything else here.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// electron-builder passes the directory it just packed; run by hand, the usual one is assumed.
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const UNPACKED = args[0] ? path.resolve(args[0]) : path.join(HERE, 'dist', 'win-unpacked')
// The afterPack hook runs BEFORE electron-builder applies the icon, so it asks for the structural
// checks only. Run on a finished build, everything is checked.
const STRUCTURE_ONLY = process.argv.includes('--structure-only')
const EXE = path.join(UNPACKED, 'mcctl.exe')
const ICO = path.join(HERE, 'build', 'icon.ico')

const problems = []
const notes = []

/** Every image in an .ico, as raw bytes. The format is a 6-byte header then 16 bytes per entry. */
function icoFrames(file) {
  const ico = fs.readFileSync(file)
  const count = ico.readUInt16LE(4)
  const frames = []
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16
    const w = ico[at] || 256
    const size = ico.readUInt32LE(at + 8)
    const offset = ico.readUInt32LE(at + 12)
    frames.push({ label: `${w}x${w}`, bytes: ico.subarray(offset, offset + size) })
  }
  return frames
}

if (STRUCTURE_ONLY) {
  notes.push('icon: checked separately once the build has finished')
} else if (!fs.existsSync(EXE)) {
  problems.push(`no packaged executable at ${EXE} - did the build finish?`)
} else if (!fs.existsSync(ICO)) {
  problems.push(`build/icon.ico is missing, so nothing could have been applied to the executable`)
} else {
  const exe = fs.readFileSync(EXE)
  const missing = icoFrames(ICO).filter((f) => !exe.includes(f.bytes)).map((f) => f.label)
  if (missing.length) {
    problems.push(
      `the app icon did not reach mcctl.exe (missing ${missing.join(', ')}).\n` +
        `    electron-builder applies it with rcedit from its winCodeSign toolchain. If that\n` +
        `    toolchain failed to extract - the usual cause is Windows refusing to create the\n` +
        `    symlinks in its unused macOS files - the build carries on and ships Electron's\n` +
        `    default icon. See desktop/build/README.md.`,
    )
  } else {
    notes.push('icon: all sizes present in mcctl.exe')
  }
}

const core = path.join(UNPACKED, 'resources', 'core')
for (const rel of ['mcctl.mjs', 'src/ui.html', 'src/ui.mjs', 'src/daemon.mjs', 'src/java.mjs']) {
  if (!fs.existsSync(path.join(core, rel))) problems.push(`resources/core/${rel} is missing from the build`)
}
if (!problems.some((p) => p.includes('resources/core'))) notes.push('core: bundled into resources/core')

const asar = path.join(UNPACKED, 'resources', 'app.asar')
if (!fs.existsSync(asar)) {
  problems.push('resources/app.asar is missing')
} else {
  // setup.html is listed in the build's `files` allowlist. Anything added to desktop/ and not
  // listed there is silently left out, and the first-run wizard is the screen that would go.
  const bytes = fs.readFileSync(asar)
  for (const name of ['main.js', 'preload.js', 'setup.html', 'window-state.js']) {
    if (!bytes.includes(Buffer.from(name))) problems.push(`${name} is not in app.asar - check the "files" list in package.json`)
  }
  if (!problems.some((p) => p.includes('app.asar'))) notes.push('app: main.js, preload.js, window-state.js and setup.html are packaged')
}

for (const note of notes) process.stdout.write(`  ok   ${note}\n`)
if (problems.length) {
  process.stdout.write('\n')
  for (const p of problems) process.stdout.write(`  FAIL ${p}\n`)
  process.stdout.write('\nThis build should not be released.\n')
  process.exit(1)
}
process.stdout.write('\nBuild looks right.\n')
