#!/usr/bin/env node
/**
 * Publish the draft release, once it is actually complete.
 *
 * <p>Releases build as drafts. A draft is invisible to electron-updater, which is a real hazard -
 * the release looks published on GitHub while nobody is offered the update, and that is a confusing
 * thing to work out weeks later. It is also the reason this project published live for its first
 * six releases.
 *
 * <p>Publishing live has the opposite hazard, and it is not theoretical: on v0.2.6 the upload of
 * the installer failed after the blockmap had gone up, leaving a release tagged, live and marked
 * Latest with nothing to download and no update feed. A client checking for updates in that window
 * got a 404.
 *
 * <p>So: build as a draft, and flip it live only after checking the things whose absence caused
 * that. Three assets, the installer's size matching what the feed claims, and the feed naming this
 * version. Then one call to make it visible.
 *
 *   npm run release          build, sign, upload as a draft
 *   npm run release:publish  check it is whole, then publish it
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'))
const { owner, repo } = pkg.build.publish[0]
const REPO = `${owner}/${repo}`
const TAG = `v${pkg.version}`

function gh(args) {
  const res = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true })
  if (res.error) {
    fail(`could not run the GitHub CLI: ${res.error.message}`)
  }
  if (res.status !== 0) fail(`gh ${args.slice(0, 2).join(' ')} failed:\n${(res.stderr || '').trim()}`)
  return res.stdout
}

function fail(message) {
  process.stdout.write(`\n  FAIL ${message}\n\nThe release has not been published.\n`)
  process.exit(1)
}

// A tag can resolve to the wrong object when more than one release claims it - which is what a
// raced draft creation leaves behind - so look at every release rather than trusting the lookup.
const all = JSON.parse(gh(['api', `repos/${REPO}/releases`, '--paginate']))
const matching = all.filter((r) => r.tag_name === TAG || r.name === TAG)
if (matching.length > 1) {
  fail(`${matching.length} releases claim ${TAG}: ids ${matching.map((r) => r.id).join(', ')}. ` +
    'The assets are split across them. Delete all but one, or delete them all and rebuild.')
}
if (matching.length === 0) fail(`no release found for ${TAG}. Build it first.`)

const found = matching[0]
const release = {
  isDraft: found.draft,
  name: found.name,
  assets: found.assets.map((a) => ({ name: a.name, size: a.size, state: a.state })),
}

if (!release.isDraft) {
  process.stdout.write(`  ok   ${TAG} is already published.\n`)
  process.exit(0)
}

// ---- everything a client needs has to be there, and be whole --------------------------------
const byName = new Map(release.assets.map((a) => [a.name, a]))
const installer = `mcctl-Setup-${pkg.version}.exe`
const expected = [installer, `${installer}.blockmap`, 'latest.yml']

for (const name of expected) {
  const asset = byName.get(name)
  if (!asset) fail(`${name} is missing from ${TAG}. That is what an interrupted upload looks like.`)
  if (asset.state !== 'uploaded') fail(`${name} is in state "${asset.state}" rather than uploaded.`)
  if (asset.size === 0) fail(`${name} uploaded as zero bytes.`)
}

// ---- the feed has to describe the file that is actually there --------------------------------
const feed = gh(['release', 'download', TAG, '--repo', REPO, '--pattern', 'latest.yml', '--output', '-'])
const version = /^version:\s*(.+)$/m.exec(feed)?.[1]?.trim()
const size = Number(/^\s+size:\s*(\d+)$/m.exec(feed)?.[1])

if (version !== pkg.version) fail(`latest.yml says version ${version}, but this is ${pkg.version}.`)
if (size !== byName.get(installer).size) {
  fail(`latest.yml claims ${size} bytes but the uploaded installer is ${byName.get(installer).size}. ` +
    'A client would reject the download as corrupt.')
}

for (const name of expected) process.stdout.write(`  ok   ${name} (${byName.get(name).size} bytes)\n`)
process.stdout.write(`  ok   latest.yml describes ${version} and matches the installer\n`)

// ---- record which commit produced the binary ------------------------------------------------
// The source repository is private and this one holds only binaries, so without this nothing
// connects the installer to the code. Read from what the BUILD wrote, not from git now: a draft can
// sit for days while the branch moves on, and the commit that matters is the one that made the file.
let footer = ''
try {
  const info = JSON.parse(fs.readFileSync(path.join(HERE, 'dist', 'build-info.json'), 'utf8'))
  if (info.version !== pkg.version) {
    fail(`dist/build-info.json is from version ${info.version}, but this is ${pkg.version}. ` +
      'That is a stale build directory - rebuild before publishing.')
  }
  if (info.commit) {
    footer = `\n\n---\nBuilt from \`${info.shortCommit}\`` +
      (info.dirty ? ' **plus uncommitted changes**' : '') +
      ` on ${info.builtAt}.`
    process.stdout.write(`  ok   built from ${info.shortCommit}${info.dirty ? ' (dirty tree)' : ''}\n`)
  }
} catch (err) {
  if (err?.code === 'ENOENT') process.stdout.write('  ok   no build-info.json; release notes will not name a commit\n')
  else throw err
}

if (footer) {
  const current = JSON.parse(gh(['release', 'view', TAG, '--repo', REPO, '--json', 'body'])).body ?? ''
  if (!current.includes('Built from')) {
    gh(['release', 'edit', TAG, '--repo', REPO, '--notes', current + footer])
  }
}

gh(['release', 'edit', TAG, '--repo', REPO, '--draft=false', '--latest'])
process.stdout.write(`\n${TAG} is now published and marked latest.\n`)
process.stdout.write(`https://github.com/${REPO}/releases/tag/${TAG}\n`)
