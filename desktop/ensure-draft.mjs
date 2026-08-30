#!/usr/bin/env node
/**
 * Create the draft release before the build uploads into it.
 *
 * <p>electron-builder uploads artifacts concurrently, and each upload looks the release up by tag
 * and creates it if it is missing. With a live release that is harmless - the tag exists the moment
 * the first one wins. With a DRAFT it is not: a draft has no git tag, the lookup misses for every
 * upload that started before the first one finished, and each creates a release of its own.
 *
 * <p>That is not hypothetical. The first v0.2.7 build produced two draft releases a second apart,
 * one holding the blockmap and the other holding the installer and the update feed - and `gh` then
 * resolved the tag to the wrong one. Splitting a release across two objects is the exact failure
 * publishing as a draft was meant to prevent.
 *
 * <p>So the draft is created up front, once, before anything is uploaded. Every upload then finds
 * it and there is nothing to race over.
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

function gh(args, { allowFailure = false } = {}) {
  const res = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true })
  if (res.error) {
    process.stdout.write(`  FAIL could not run the GitHub CLI: ${res.error.message}\n`)
    process.exit(1)
  }
  if (res.status !== 0 && !allowFailure) {
    process.stdout.write(`  FAIL gh ${args.slice(0, 2).join(' ')}:\n${(res.stderr || '').trim()}\n`)
    process.exit(1)
  }
  return { ok: res.status === 0, out: res.stdout }
}

const all = JSON.parse(gh(['api', `repos/${REPO}/releases`, '--paginate']).out)
const matching = all.filter((r) => r.tag_name === TAG || r.name === TAG)

if (matching.length > 1) {
  process.stdout.write(
    `  FAIL ${matching.length} releases already exist for ${TAG}. Delete the extras before ` +
      'building, or the assets will be split across them again.\n',
  )
  process.exit(1)
}

if (matching.length === 1) {
  const state = matching[0].draft ? 'draft' : 'PUBLISHED'
  if (!matching[0].draft) {
    process.stdout.write(
      `  FAIL ${TAG} is already published. Bump the version rather than overwriting a release ` +
        'people may already have downloaded.\n',
    )
    process.exit(1)
  }
  process.stdout.write(`  ok   ${TAG} ${state} already exists; the build will upload into it\n`)
} else {
  const notes = path.join(HERE, `RELEASE-NOTES-${TAG}.md`)
  const args = ['release', 'create', TAG, '--repo', REPO, '--draft', '--title', TAG]
  if (fs.existsSync(notes)) args.push('--notes-file', notes)
  else args.push('--notes', 'Release notes to follow.')
  gh(args)
  process.stdout.write(`  ok   created draft ${TAG} for the build to upload into\n`)
}
