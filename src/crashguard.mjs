/**
 * Whether a dead server should be brought back, and when.
 *
 * <p>Kept apart from the daemon and free of I/O so the decision itself can be tested - the
 * daemon cannot be imported without becoming one.
 *
 * <p>The rules, and why they are the rules:
 *
 * <ul>
 *   <li>A stop that was asked for stays stopped, whatever the exit code. Fighting the person
 *       who typed "stop" is the worst thing a supervisor can do.</li>
 *   <li>A clean exit stays stopped even when nobody asked through mcctl: "stop" typed straight
 *       into the server console never passes through the daemon, and the only trace it leaves
 *       is exit code 0. Restarting THAT would make the console command unusable.</li>
 *   <li>A crash comes back after a short delay - long enough for the port and the world's file
 *       locks to be released, short enough that nobody has to notice.</li>
 *   <li>A server that keeps crashing stops being restarted. A broken plugin can take a server
 *       down within seconds of ready; restarting it forever turns one crash into a machine
 *       grinding all night. Three strikes inside ten minutes and it stays down, saying so.</li>
 * </ul>
 */

export const CRASH_WINDOW_MS = 10 * 60 * 1000
export const CRASH_LIMIT = 3
// Ten seconds: long enough for the port and the world's file locks to be released. The override
// exists for the lifecycle tests, which would otherwise spend ten seconds per crash waiting on it.
export const RESTART_DELAY_MS = Number(process.env.MCCTL_RESTART_DELAY_MS) > 0
  ? Number(process.env.MCCTL_RESTART_DELAY_MS)
  : 10 * 1000

/**
 * Decide what to do about an exit. `crashes` is every crash timestamp so far, INCLUDING the
 * one being decided about - the caller records first, then asks.
 */
export function crashVerdict({ enabled, stopping, code, signal, crashes = [], now = Date.now() }) {
  if (stopping) return { kind: 'stay-down', why: 'stop was requested' }
  if (code === 0 && !signal) return { kind: 'stay-down', why: 'clean exit' }
  if (!enabled) return { kind: 'stay-down', why: 'auto-restart is off' }
  const recent = crashes.filter((t) => now - t <= CRASH_WINDOW_MS).length
  if (recent >= CRASH_LIMIT) return { kind: 'give-up', recent }
  return { kind: 'restart', delayMs: RESTART_DELAY_MS, recent }
}
