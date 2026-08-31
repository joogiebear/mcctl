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
- **Plugin manager** — a Plugins tab and `mcctl plugins`: installed jars read from
  their own manifests (zero-dependency zip reader), Modrinth search and install
  filtered to compatible builds, hash-based update check, one-click update with a
  plugins snapshot first, enable/disable by renaming in place.

- **Server updates** — `mcctl upgrade` and a "Server software" card in Settings: a
  routine one-click move to the newest Paper build (old jar kept as the way back), and
  a deliberately harder, confirmed, snapshot-first path for crossing Minecraft
  versions, because worlds migrate one-way.

## Next

- **Hangar as a second plugin source**, for the Paper-ecosystem plugins that never
  publish to Modrinth.

## Later

- **Fabric / NeoForge, and Modrinth modpacks.** Support loader jars beyond Paper, then
  install a `.mrpack` as a server in one click - the biggest audience this tool does not
  serve yet.
- **A Share screen.** The honest answer to "how do my friends join?": the LAN address
  plainly, UPnP as an explicit opt-in, and real guidance for Tailscale / playit.gg for
  play over the internet. Exposure stays a deliberate user decision; this makes it an
  informed one.
- **World import and export.** Drop a downloaded map into a server; export a world as an
  archive to share. Thin wrappers over what backup.mjs already does.
- **Scheduled verify.** A `verify` action for the scheduler, so backup integrity is
  checked on a clock and failures arrive over the webhook.
- **Log intelligence.** The console already classifies levels; recognising the common
  failure shapes (missing Vault, wrong Java, port in use) and saying so is the next step.
  A crash-report viewer belongs here too.

## Reach

- **Distribution.** Screenshots in the README, a winget manifest, a public landing.
  People cannot want a tool they cannot find.
- **Linux / macOS.** Everything except `schedule.mjs` (schtasks) and a few paths is
  nearly portable already.
- Localization.
