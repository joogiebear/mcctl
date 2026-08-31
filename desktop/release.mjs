#!/usr/bin/env node
/**
 * Build, sign and upload a release.
 *
 * <p>Exists for one reason: electron-builder reads its GitHub credential from `GH_TOKEN` and
 * nowhere else. The `gh` CLI is already authenticated on any machine that publishes from here -
 * every other release step uses it - but it keeps its token in its own config, so a shell without
 * that variable set builds for four minutes, signs everything, and then fails on the upload with
 * "GitHub Personal Access Token is not set". That happened on v0.3.0.
 *
 * <p>So the token is fetched from `gh` when the variable is absent, and the whole thing fails in
 * the first second rather than the fourth minute when it cannot be found at all.
 */
import { spawnSync } from 'node:child_process'

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32', ...opts })
}

function fail(message) {
  process.stdout.write(`\n  FAIL ${message}\n\nNothing has been built.\n`)
  process.exit(1)
}

let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
if (!token) {
  const res = run('gh', ['auth', 'token'])
  if (res.status === 0 && res.stdout.trim()) {
    token = res.stdout.trim()
    process.stdout.write('  ok   using the token gh is already signed in with\n')
  }
}
if (!token) {
  fail(
    'no GitHub token. Either sign in with "gh auth login", or set GH_TOKEN.\n' +
      '  electron-builder reads that variable and nothing else, and it only notices at upload time.',
  )
}

// The draft is created first, once, so the concurrent uploads have something to upload into
// rather than each creating a release of their own. See ensure-draft.mjs.
const draft = run('node', ['ensure-draft.mjs'], { stdio: 'inherit', encoding: undefined })
if (draft.status !== 0) process.exit(draft.status ?? 1)

const build = run('npx', ['electron-builder', '--publish', 'always'], {
  stdio: 'inherit',
  encoding: undefined,
  env: { ...process.env, GH_TOKEN: token },
})
process.exit(build.status ?? 1)
