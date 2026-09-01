# Roadmap

What mcctl is for shapes what goes on this list: one person's Windows machine, running
servers for friends, family or plugin testing, with no accounts, no cloud, no Docker, and
nothing exposed to a network without a deliberate decision. Features that serve that
person go on the list; features that turn this into a smaller Pterodactyl - multi-node,
user accounts, a remote web panel - stay off it on purpose.

## Done

- **Reliability** *(v0.6 line)* — crash auto-restart with a crash-loop stop, scheduled
  restarts that warn the players first, Discord webhook notifications for the events
  nobody is watching for, and `mcctl verify` to prove snapshots actually restore.
- **Plugin manager** — a Plugins tab and `mcctl plugins`: Modrinth search and install
  filtered to compatible builds, hash-based update check, one-click update with a
  plugins snapshot first, enable/disable by renaming in place. Manages only what it
  installed (provenance recorded beside the jars); hand-dropped custom and premium
  plugins are left alone and never hashed to anyone.

- **Server updates** — `mcctl upgrade` and a "Server software" card in Settings: a
  routine one-click move to the newest Paper build (old jar kept as the way back), and
  a deliberately harder, confirmed, snapshot-first path for crossing Minecraft
  versions, because worlds migrate one-way.

- **Hangar as a second plugin source** *(v0.6.2)* — searched alongside Modrinth with
  the source named on every result, sha256-verified installs, and version-name update
  checks against the provenance record. External-download projects (premium and
  elsewhere-hosted) are linked to rather than pretended at; a sparse version claim is
  offered with the mismatch said out loud.

- **Modded servers, complete** *(0.6.x; docs/modpacks-plan.md)* — Fabric and NeoForge
  as first-class loaders with a Mods tab, "From a modpack" in Add-a-server for both,
  pack updates that may only touch what the old pack owned, and the server's version
  treated as a preference rather than a wall: search shows the loader's whole
  ecosystem, and a mismatched build installs with the author's version claim stated.
- **Form controls with depth** *(v0.6.6)* — carved fields, an owned select chevron,
  drawn radios, troughed switches; the wizard matches the panel.

## Later

- **World import and export.** Drop a downloaded map into a server; export a world as an
  archive to share. Thin wrappers over what backup.mjs already does.
- **Scheduled verify.** A `verify` action for the scheduler, so backup integrity is
  checked on a clock and failures arrive over the webhook.
- **Log intelligence.** The console already classifies levels; recognising the common
  failure shapes (missing Vault, wrong Java, port in use) and saying so is the next step.
  A crash-report viewer belongs here too.

## After 1.0

- **A Share screen** *(tabled 2026-09-01, owner's call — likely post-1.0)*. The honest
  answer to "how do my friends join?", in tiers of increasing exposure: the LAN address
  plainly; "direct" keeping a DNS record on the owner's own domain pointed at the home
  IP with SRV for the port and UPnP as an explicit opt-in; "tunnel" via playit.gg or a
  self-owned VPS relay, no ports opened and the home IP hidden. Exposure stays a
  deliberate user decision; this screen's whole job is making it an informed one, with
  whitelist and online-mode nudged on at the moment anything goes public.

## Reach

- **Distribution.** Screenshots in the README, a winget manifest, a public landing.
  People cannot want a tool they cannot find.
- **Linux / macOS.** Everything except `schedule.mjs` (schtasks) and a few paths is
  nearly portable already.
- Localization.
