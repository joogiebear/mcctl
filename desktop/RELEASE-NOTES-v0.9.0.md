Every server, not just Paper

Add a server now offers nine kinds of software, and each one runs under the
same daemon, console, backups and scheduler as before. Pick it from the
Software list, or name it from a terminal: `mcctl new smp --purpur 26.2`.

## New kinds

- **Purpur** — a Paper fork with more configuration. Downloaded from
  purpurmc.org, md5-verified.
- **Folia** — Paper with regionised multithreading. From PaperMC, alongside
  Paper. Only plugins built for Folia will load, and the Plugins tab searches
  for exactly those.
- **Advanced Slime Paper** — Paper with Slime World Manager built in, from
  InfernalSuite's build list, sha256-verified.
- **Vanilla** — Mojang's own server, unmodified, from the launcher manifest.
  It loads no plugins and no mods, and the Plugins tab says so instead of
  offering downloads into a folder the server never reads.
- **Spigot** and **CraftBukkit** — SpigotMC publishes no jars, so these are
  **compiled on your machine** by SpigotMC's own BuildTools. It needs a JDK
  (checked for before the wait, not after), fetches a portable git for itself,
  and takes a few minutes the first time for a version; the panel narrates the
  build line by line. About a gigabyte of clones stays under the jar store so
  later builds are faster.

Paper, Fabric and NeoForge are unchanged. `--build <n>` picks a specific build
for the sources that number them.

## Follows the software

- The Plugins tab searches Modrinth with the right loader for each kind:
  Purpur finds Purpur, Paper, Spigot and Bukkit builds; Spigot finds Spigot
  and Bukkit only, because a plugin that needs Paper's API will not load there.
  Hangar is offered where it makes sense.
- Adding an existing server recognises Purpur, Folia, Spigot, CraftBukkit and
  vanilla from the jar's name.

## Also

- **Java 25.** Minecraft 26.x needs Java 25 and the Java check now says so;
  it previously called 21 current and pointed the download link at it. 1.21.x
  still runs on 21, and the check still says that too.
- `upgrade` still knows Paper only. Other kinds move versions by creating a
  new server or importing a newer jar.
