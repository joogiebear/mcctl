'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

/**
 * Guard the build before it can become a release.
 *
 * <p>There is no CI on this repository, and `npm run release` publishes live rather than as a
 * draft, so this hook is the only thing between a wrong build and a public download.
 *
 * <p>Two jobs, because they have to happen at different moments:
 *
 * <ol>
 *   <li><b>Structure</b>, checked here and now: the core, the panel and the wizard are all present
 *       in what was just packed.</li>
 *   <li><b>The icon</b>, which cannot be checked here - electron-builder applies it with rcedit
 *       AFTER this hook runs, and the `afterSign` hook that comes later is skipped entirely for an
 *       unsigned build. So rather than checking the result, this checks the cause: whether rcedit
 *       is available at all. When it is not, electron-builder logs a warning and ships Electron's
 *       default atom, which is the silent failure that went out in v0.1.0.</li>
 * </ol>
 *
 * <p>`npm run verify` checks the finished artifact, and is the belt to this hook's braces.
 */
/**
 * Where rcedit is, according to whichever electron-builder this is.
 *
 * <p>There is no public API for this, and the internal one moved between 24 and 26 -
 * `getSignVendorPath` in codeSign/windowsCodeSign became `getRceditBundle` in toolsets/windows. So
 * this tries what it knows and returns null when it recognises nothing, rather than pretending a
 * missing resolver is a missing toolchain.
 */
async function findRcedit(context) {
  // electron-builder 25+
  try {
    const { getRceditBundle } = require('app-builder-lib/out/toolsets/windows')
    if (typeof getRceditBundle === 'function') {
      const bundle = await getRceditBundle(context.packager.config.toolsets?.winCodeSign)
      return bundle?.x64 ?? null
    }
  } catch {
    /* fall through to the older shape */
  }
  // electron-builder 24
  try {
    const { getSignVendorPath } = require('app-builder-lib/out/codeSign/windowsCodeSign')
    if (typeof getSignVendorPath === 'function') return path.join(await getSignVendorPath(), 'rcedit-x64.exe')
  } catch {
    /* neither shape is available */
  }
  return null
}

exports.default = async function afterPack(context) {
  // ---- 1. the icon toolchain has to exist, or the icon is silently skipped -------------------
  if (context.packager.platformSpecificBuildOptions.signAndEditExecutable !== false) {
    const rcedit = await findRcedit(context)
    if (rcedit == null) {
      // Not knowing is not the same as knowing it is broken, and a guard that fails a good build
      // because electron-builder moved a private function is worse than no guard. `npm run verify`
      // checks the finished executable for the icon bytes themselves and is the real authority.
      console.warn(
        '  warn rcedit could not be located through any known electron-builder internal, so the\n' +
          '       icon pre-flight was skipped. Run "npm run verify" after the build.',
      )
    } else if (!fs.existsSync(rcedit)) {
      throw new Error(
        `rcedit is missing from ${rcedit}, so the app icon would not reach mcctl.exe and this ` +
          "build would ship Electron's default icon without failing. " +
          'See desktop/build/README.md. Nothing has been published.',
      )
    }
  }

  // ---- 2. everything the app needs is actually in the package --------------------------------
  const res = spawnSync(
    process.execPath,
    [path.join(__dirname, 'verify-build.mjs'), context.appOutDir, '--structure-only'],
    { stdio: 'inherit' },
  )
  if (res.status !== 0) {
    throw new Error('build verification failed - see the report above. Nothing has been published.')
  }
}
