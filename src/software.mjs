/**
 * Every kind of server mcctl can create, described once.
 *
 * <p>Pure: no network, no filesystem, so plugins.mjs can read "what does this loader load"
 * from it without dragging every download client into the import graph, and so the table
 * itself is testable. Where each one is fetched from lives in sources.mjs.
 *
 * <p>`family` is what the daemon and the content tab care about:
 * <ul>
 *   <li><b>bukkit</b> - Paper and everything downstream or upstream of it. Loads plugins from
 *       plugins/. Purpur, Folia and Advanced Slime Paper are Paper forks; Spigot and CraftBukkit
 *       are what Paper forked from.</li>
 *   <li><b>fabric</b>, <b>neoforge</b> - mod loaders. Load mods from mods/.</li>
 *   <li><b>vanilla</b> - Mojang's own server. Loads nothing.</li>
 * </ul>
 *
 * <p>`modrinth` is the loader facet a search sends, widest-compatible first. Paper runs Spigot
 * and Bukkit plugins; Purpur runs all of those and its own; Folia runs only plugins built for
 * it, and Spigot cannot load a plugin that needs Paper's API - so the lists narrow down the tree.
 * `hangar` says whether PaperMC's plugin platform is a sensible second source: it hosts Paper
 * plugins, which are exactly what a Spigot server cannot promise to run.
 */
export const SOFTWARE = [
  {
    id: 'paper',
    label: 'Paper',
    family: 'bukkit',
    content: 'plugins',
    modrinth: ['paper', 'spigot', 'bukkit', 'folia'],
    hangar: true,
    blurb: 'Downloads the newest stable Paper build.',
  },
  {
    id: 'purpur',
    label: 'Purpur',
    family: 'bukkit',
    content: 'plugins',
    modrinth: ['purpur', 'paper', 'spigot', 'bukkit', 'folia'],
    hangar: true,
    blurb: 'A Paper fork with more configuration. Downloads the newest Purpur build.',
  },
  {
    id: 'folia',
    label: 'Folia',
    family: 'bukkit',
    content: 'plugins',
    modrinth: ['folia'],
    hangar: false,
    blurb: 'Paper with regionised multithreading. Only plugins built for Folia will load.',
  },
  {
    id: 'asp',
    label: 'Advanced Slime Paper',
    family: 'bukkit',
    content: 'plugins',
    modrinth: ['paper', 'spigot', 'bukkit', 'folia'],
    hangar: true,
    blurb: 'Paper with Slime World Manager built in, from InfernalSuite. Downloads the newest build.',
  },
  {
    id: 'spigot',
    label: 'Spigot',
    family: 'bukkit',
    content: 'plugins',
    modrinth: ['spigot', 'bukkit'],
    hangar: false,
    // SpigotMC publishes no jars: BuildTools compiles one here from source. Said up front,
    // because a create that takes ten minutes with no warning reads as a hang.
    slow: true,
    blurb: 'Compiled on this machine by SpigotMC’s BuildTools. Needs a JDK and takes five to ten minutes the first time.',
  },
  {
    id: 'craftbukkit',
    label: 'CraftBukkit',
    family: 'bukkit',
    content: 'plugins',
    modrinth: ['bukkit'],
    hangar: false,
    slow: true,
    blurb: 'Compiled on this machine by SpigotMC’s BuildTools. Needs a JDK and takes five to ten minutes the first time.',
  },
  {
    id: 'vanilla',
    label: 'Vanilla',
    family: 'vanilla',
    content: 'none',
    modrinth: [],
    hangar: false,
    blurb: 'Mojang’s own server, unmodified. No plugins and no mods.',
  },
  {
    id: 'fabric',
    label: 'Fabric',
    family: 'fabric',
    content: 'mods',
    modrinth: ['fabric'],
    hangar: false,
    blurb: 'Downloads the Fabric server launcher, which fetches the rest on first start.',
  },
  {
    id: 'neoforge',
    label: 'NeoForge',
    family: 'neoforge',
    content: 'mods',
    modrinth: ['neoforge'],
    hangar: false,
    blurb: 'Runs the NeoForge installer, which downloads its libraries. Takes a few minutes.',
  },
]

const BY_ID = new Map(SOFTWARE.map((s) => [s.id, s]))

/** The table row for a loader id. Unknown and absent both mean Paper - see registry.loaderOf. */
export function softwareOf(loader) {
  return BY_ID.get(loader) ?? BY_ID.get('paper')
}

export function isSoftware(id) {
  return BY_ID.has(id)
}

/** Ids whose server is one jar fetched into the store; NeoForge is installed instead. */
export const JAR_IDS = SOFTWARE.filter((s) => s.id !== 'neoforge').map((s) => s.id)

/**
 * The Minecraft version a jar's own name says it is for, or null. Every source names its jar
 * `<id>-<mc>...` on purpose so an instance made before mcVersion was recorded still answers.
 */
export function versionFromJar(jar) {
  const name = String(jar || '')
  const m = /^(?:paper|purpur|folia|asp|spigot|craftbukkit|vanilla)-(\d+\.\d+(?:\.\d+)?)/i.exec(name)
    ?? /^fabric-server-mc\.(\d+\.\d+(?:\.\d+)?)-/i.exec(name)
  return m ? m[1] : null
}

/**
 * Which software an adopted server is, guessed the way a person would: from the jar's name,
 * and for NeoForge from the libraries tree its installer leaves. Anything unrecognised is
 * treated as Paper, which is what every adopted server had been until there were choices.
 */
export function guessLoader(jar, { hasNeoforgeLibs = false } = {}) {
  const name = String(jar || '')
  if (/^fabric-server/i.test(name)) return 'fabric'
  if (hasNeoforgeLibs) return 'neoforge'
  const m = /^(purpur|folia|asp|spigot|craftbukkit|vanilla)-/i.exec(name)
  if (m) return m[1].toLowerCase()
  return 'paper'
}
