import fs from 'node:fs'
import path from 'node:path'

import { readProps } from './props.mjs'

/**
 * Who a world already knows about, and under which kind of identity.
 *
 * <p>Minecraft stores one `<uuid>.dat` per player who has joined, and the UUID it uses depends on
 * whether the server was in online mode at the time:
 *
 * <ul>
 *   <li><b>Online</b> - the account's real Mojang UUID, which is a random (version 4) UUID.</li>
 *   <li><b>Offline</b> - a UUID derived from the player's name by hashing it, which is a
 *       name-based (version 3) UUID.</li>
 * </ul>
 *
 * <p>The version is the first hex digit of a UUID's third group, so the two are told apart by
 * reading the filename. That distinction is the whole reason this exists: turning online mode on
 * for a world that has offline players in it does not migrate them, it gives everyone a different
 * identity. Permissions, homes, inventories and anything else a plugin keyed by UUID stay attached
 * to the old one, and the same person joins as a stranger.
 *
 * <p>Worth a warning before the switch rather than a support question after it.
 */

const UUID_FILE = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f])([0-9a-f]{3})-([0-9a-f]{4})-([0-9a-f]{12})\.dat$/i

export function storedPlayers(instDir) {
  const props = readProps(path.join(instDir, 'server.properties'))
  const level = props.get('level-name') || 'world'
  const dir = path.join(instDir, level, 'playerdata')

  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    // No playerdata directory means nobody has ever joined, which is the common case for a server
    // that was just created and the one where no warning is needed.
    return { count: 0, offline: 0, online: 0, unknown: 0 }
  }

  let offline = 0
  let online = 0
  let unknown = 0
  for (const entry of entries) {
    const m = UUID_FILE.exec(entry)
    if (!m) continue
    const version = m[3].toLowerCase()
    if (version === '3') offline++
    else if (version === '4') online++
    else unknown++
  }
  return { count: offline + online + unknown, offline, online, unknown }
}
