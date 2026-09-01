Every loader, every version

## NeoForge servers

The Software choice in **Add a server** now offers NeoForge alongside Paper and
Fabric — `mcctl new <name> --neoforge <version>` from a terminal. The installer
is fetched from NeoForge's own maven, checksummed, and run into the new
instance; if it fails partway, the half-built server is removed rather than
left looking created. The Mods tab reads NeoForge manifests, installs NeoForge
builds from Modrinth, and everything you already rely on — crash auto-restart,
webhooks, backups and verify, the scheduler — works unchanged, because a
NeoForge server launches through a single `server.jar` like every other server
mcctl runs.

**Modpacks too**: *From a modpack* now offers server-ready NeoForge packs
alongside Fabric ones, and pack updates handle either. Adopting an existing
NeoForge server recognises it by its libraries tree.

## Your version is a preference, not a wall

Searching for plugins and mods used to hide anything that did not list your
server's exact Minecraft version — which, given how sparsely authors maintain
those lists, hid half of what would actually run. Search now shows the loader's
whole ecosystem. Installing still prefers a build for your exact version; when
there is none, the newest build for your loader installs **with the author's
version claim stated** — "its newest build lists 26.1.2, not your 26.2" is
information you should have, not a decision made for you.
