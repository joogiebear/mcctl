import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { runDir } from './paths.mjs'

/**
 * How hard a server is working, over time.
 *
 * <p>Node can measure its own CPU and nothing else's, and the thing worth measuring is the java
 * process the daemon started. Windows will report it, but only through a tool: Get-Process gives
 * total processor seconds and working set for any pid.
 *
 * <p>Calling that once per sample would mean spawning PowerShell every ten seconds for as long as
 * the server runs, which is a process launch per sample to read two numbers. Instead one PowerShell
 * is started with the server and left running, refreshing the same process object in a loop and
 * printing a line each time. One extra process for the life of the server, not one per reading.
 *
 * <p>Samples go to a plain text file in the run directory rather than being held in memory,
 * because the thing that reads them is the panel, in a different process, possibly started after
 * the server was.
 */

/** Ten seconds. Four hours of history is 1440 samples, which is a file of about thirty kilobytes. */
const INTERVAL_SEC = 10

/** Five hours kept, so the four-hour view is always full rather than filling up as you watch. */
const KEEP = 1800

/** Trimmed in batches; rewriting the file every ten seconds to drop one line is not worth it. */
const TRIM_AT = KEEP + 600

export function metricsFile(name) {
  return path.join(runDir(name), 'metrics.log')
}

/**
 * CPU as a share of the whole machine, the way Task Manager counts it.
 *
 * <p>Per-core would read above 100% and invite the question of how many cores there are. This does
 * not, at the cost of a server pinning one core of sixteen looking quiet - so the core count is
 * reported alongside and the panel says what the number is a share of.
 */
const CORES = Math.max(1, os.cpus()?.length || 1)

/**
 * Watch a process until it exits.
 *
 * <p>Returns a function that stops watching. Failure to start the sampler is not failure to start
 * the server: a graph is worth less than the thing it graphs, so this reports and gives up rather
 * than taking the daemon down with it.
 */
export function startSampler(name, pid, { onError = () => {} } = {}) {
  if (process.platform !== 'win32') {
    // Everywhere else would need a different tool and this project ships for Windows. Saying so
    // beats a graph that is silently always empty.
    onError(new Error('performance sampling is only implemented on Windows'))
    return () => {}
  }

  const file = metricsFile(name)
  fs.mkdirSync(path.dirname(file), { recursive: true })

  const script = [
    '$ErrorActionPreference = "Stop"',
    // Every number is printed in the invariant culture. PowerShell formats a double with the
    // machine's decimal separator otherwise, so on a German Windows the CPU figure arrives as
    // "29,765" and parses as 29 - a wrong graph rather than a missing one.
    '$inv = [System.Globalization.CultureInfo]::InvariantCulture',
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    'if (-not $p) { exit 0 }',
    'while ($true) {',
    '  try { $p.Refresh() } catch { break }',
    '  if ($p.HasExited) { break }',
    // ToUnixTimeSeconds, not Get-Date -UFormat %s: that is culture-formatted too. And the line
    // is concatenated rather than built with -f, because the cast in `[int][double]::Parse(x), a, b`
    // binds to the whole comma list instead of the first item and the format silently produced
    // nothing at all.
    '  $t = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()',
    '  $c = $p.CPU',
    '  if ($null -eq $c) { $c = 0 }',
    // Written through [Console] and flushed: PowerShell buffers its own output pipeline, and a
    // sample that arrives in a batch ten minutes later is not a sample of anything useful.
    '  [Console]::Out.WriteLine($t.ToString($inv) + " " + $c.ToString($inv) + " " + $p.WorkingSet64.ToString($inv))',
    '  [Console]::Out.Flush()',
    `  Start-Sleep -Seconds ${INTERVAL_SEC}`,
    '}',
  ].join('\n')

  const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let prev = null
  let written = 0
  let buf = ''

  ps.stdout.on('data', (chunk) => {
    buf += chunk
    const lines = buf.split(/\r?\n/)
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const [ts, cpuSec, rss] = line.trim().split(/\s+/)
      const at = Number(ts)
      const seconds = Number(cpuSec)
      const bytes = Number(rss)
      if (!Number.isFinite(at) || !Number.isFinite(seconds) || !Number.isFinite(bytes)) continue
      // The first line establishes a baseline and produces no sample: CPU is a rate, and a rate
      // needs two readings.
      if (prev) {
        const wall = at - prev.at
        if (wall > 0) {
          const pct = Math.max(0, Math.min(100, ((seconds - prev.seconds) / (wall * CORES)) * 100))
          fs.appendFileSync(file, `${at} ${pct.toFixed(1)} ${Math.round(bytes / 1048576)}\n`)
          if (++written % 60 === 0) trim(file)
        }
      }
      prev = { at, seconds }
    }
  })

  ps.on('error', onError)
  return () => { try { ps.kill() } catch { /* already gone with the server */ } }
}

function trim(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    if (lines.length <= TRIM_AT) return
    fs.writeFileSync(file, lines.slice(-KEEP).join('\n') + '\n')
  } catch {
    /* a sample lost to a locked file is one gap in a graph */
  }
}

/**
 * Every sample kept for this server, oldest first.
 *
 * <p>Unfiltered on purpose. Windowing happens in the caller, which needs to know both what falls
 * inside the range and whether anything falls outside it - a stopped server whose history is older
 * than the chosen window has plenty recorded, and telling someone "nothing recorded" because they
 * were looking at the last five minutes is a lie about their own data.
 */
export function readSamples(name) {
  let text
  try {
    text = fs.readFileSync(metricsFile(name), 'utf8')
  } catch {
    return []
  }
  const rows = []
  for (const line of text.split('\n')) {
    if (!line) continue
    const [ts, cpu, rss] = line.split(' ')
    const at = Number(ts)
    if (!Number.isFinite(at)) continue
    rows.push({ at, cpu: Number(cpu), rss: Number(rss) })
  }
  return rows
}

export const SAMPLE_SECONDS = INTERVAL_SEC
export const CPU_CORES = CORES
