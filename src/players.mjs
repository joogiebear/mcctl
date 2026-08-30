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

// The version digit is the first character of a UUID's third group. The extension varies by which
// directory the file came from - .dat for saved player state, .json for stats and advancements.
const UUID_FILE = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f])([0-9a-f]{3})-([0-9a-f]{4})-([0-9a-f]{12})\.(dat|json)$/i

/**
 * Every directory a joined player might have left a file in.
 *
 * <p>Minecraft moved these. Up to and including the classic layout a server kept
 * `<level>/playerdata/<uuid>.dat` with `stats` and `advancements` as siblings; Paper 26.2 keeps all
 * three under `<level>/players/`, and nests the nether and the end inside `<level>/dimensions/`
 * rather than as `<level>_nether` beside it. Looking only in the old place is how the first version
 * of this reported zero players for a world that had one - and the online-mode warning it feeds
 * therefore never appeared.
 *
 * <p>All of them are read and unioned by UUID rather than picking a layout, because both exist in
 * the wild, and because a player who has joined but whose state has not been written yet still has
 * a stats file. The question being answered is "has this world seen this player", not "is there a
 * .dat".
 */
function playerDirs(instDir, level) {
  return [
    path.join(instDir, level, 'players', 'data'),
    path.join(instDir, level, 'players', 'stats'),
    path.join(instDir, level, 'players', 'advancements'),
    path.join(instDir, level, 'playerdata'),
    path.join(instDir, level, 'stats'),
    path.join(instDir, level, 'advancements'),
  ]
}

export function storedPlayers(instDir) {
  const props = readProps(path.join(instDir, 'server.properties'))
  const level = props.get('level-name') || 'world'

  // Keyed by UUID: the same player appears in several of these directories, and counting files
  // would report one person three times.
  const seen = new Map()
  for (const dir of playerDirs(instDir, level)) {
    let entries
    try {
      entries = fs.readdirSync(dir)
    } catch {
      // Absent is the normal case for most of these; nobody having joined is not an error.
      continue
    }
    for (const entry of entries) {
      const m = UUID_FILE.exec(entry)
      if (!m) continue
      seen.set(entry.slice(0, 36).toLowerCase(), m[3].toLowerCase())
    }
  }

  let offline = 0
  let online = 0
  let unknown = 0
  for (const version of seen.values()) {
    if (version === '3') offline++
    else if (version === '4') online++
    else unknown++
  }
  return { count: seen.size, offline, online, unknown }
}
