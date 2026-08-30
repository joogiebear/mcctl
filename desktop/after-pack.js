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
exports.default = async function afterPack(context) {
  // ---- 1. the icon toolchain has to exist, or the icon is silently skipped -------------------
  if (context.packager.platformSpecificBuildOptions.signAndEditExecutable !== false) {
    let vendor = null
    try {
      const { getSignVendorPath } = require('app-builder-lib/out/codeSign/windowsCodeSign')
      vendor = await getSignVendorPath()
    } catch (err) {
      throw new Error(
        "could not resolve electron-builder's winCodeSign toolchain, which is what applies the " +
          `app icon to mcctl.exe: ${err.message}. ` +
          'See desktop/build/README.md for the fix. Nothing has been published.',
      )
    }
    const rcedit = path.join(vendor, 'rcedit-x64.exe')
    if (!fs.existsSync(rcedit)) {
      throw new Error(
        `rcedit is missing from ${vendor}, so the app icon would not reach mcctl.exe and this ` +
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
