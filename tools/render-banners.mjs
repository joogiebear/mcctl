#!/usr/bin/env node
/**
 * Render site/banner/banner.html to the PNGs a partner site embeds.
 *
 * <p>Needs a Chromium: `npx playwright-core` is not a dependency of mcctl, so this is run by hand
 * on a machine that has one - `npm i -g playwright-core` and a browser it can find, or pass the
 * executable with MCCTL_CHROMIUM. The PNGs are committed; the HTML is the source to edit.
 *
 *   node tools/render-banners.mjs
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const dir = path.join(HERE, '..', 'site', 'banner')
const require = createRequire(import.meta.url)

let chromium
try {
  ({ chromium } = require('playwright-core'))
} catch {
  process.stderr.write('playwright-core is not installed. `npm i -g playwright-core`, then run this again.\n')
  process.exit(1)
}

const browser = await chromium.launch({ executablePath: process.env.MCCTL_CHROMIUM || undefined })
const page = await browser.newPage({ deviceScaleFactor: 2 })
await page.goto(pathToFileURL(path.join(dir, 'banner.html')).href)
for (const [id, name] of [['b728', 'mcctl-728x90'], ['b300', 'mcctl-300x250'], ['b468', 'mcctl-468x60']]) {
  const el = await page.$(`#${id}`)
  const file = path.join(dir, `${name}.png`)
  await el.screenshot({ path: file, omitBackground: true })
  process.stdout.write(`  ok   ${path.relative(process.cwd(), file)}\n`)
}
await browser.close()
