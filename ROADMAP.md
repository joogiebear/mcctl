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

## Next

- **Plugin manager.** A Plugins tab: list installed jars (from each `plugin.yml`),
  search and install from Modrinth and Hangar, one-click update with a pre-update
  snapshot, enable/disable via a `_disabled/` folder. Modrinth's version metadata means
  "this build does not support your Minecraft version" is caught before the download.
- **Server updates.** "Paper build N is available → Update" on the server header:
  snapshot, swap the jar, restart. Louder version for Minecraft version upgrades.
  `paper.mjs` already lists and fetches builds; this is the missing button.

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
