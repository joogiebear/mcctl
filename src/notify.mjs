/**
 * Outbound notifications, for the moments nobody is watching the panel.
 *
 * <p>One shape: a Discord webhook URL stored per instance. Outbound HTTPS only, sent only for
 * events someone would want woken up for - a crash, a recovery, a scheduled task that failed.
 * Routine lifecycle stays quiet: a person starting their own server does not need a message
 * saying they did.
 *
 * <p>Failure to deliver is never allowed to become the daemon's problem: a webhook that is
 * down gets one line in the daemon log and the server carries on.
 */

/** The Discord payload for one event. Exported so the shape is pinned by a test. */
export function formatDiscord(instanceName, message) {
  return { content: `**${instanceName}** — ${message}` }
}

/** True if this looks like a URL a webhook can be posted to. */
export function acceptableWebhook(url) {
  try {
    const u = new URL(String(url))
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

export async function notifyInstance(inst, message, { log = () => {} } = {}) {
  const url = inst?.webhook
  if (!url) return false
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(formatDiscord(inst.name, message)),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) log(`webhook answered ${res.status}`)
    return res.ok
  } catch (err) {
    log(`webhook failed: ${err.message}`)
    return false
  }
}
