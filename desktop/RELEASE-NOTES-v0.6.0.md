The server looks after itself

Four things that used to need a person now have a switch, a schedule, or a
button — and the one thing that should never happen on its own still cannot.

## Crashed servers come back

Turn on **Restart it automatically** (Settings → *If it crashes*, or
`mcctl set <name> auto-restart=on`) and a crash relaunches the server ten
seconds later, in place, with the console lines that caused it preserved above
the recovery. Three crashes in ten minutes and it stays down saying why, so a
broken plugin cannot grind the machine all night.

A stop you asked for always sticks — including `stop` typed straight into the
server console. Toggling the switch applies to a running server from its next
exit; nothing needs restarting to arm it.

## A Discord webhook for the moments nobody is watching

Paste a webhook into the same card and mcctl posts when the server crashes,
recovers, gives up, or a scheduled task fails in the night. Routine starts and
stops stay quiet on purpose.

## A plugin manager

A new **Plugins** tab: everything in the plugins folder with what its own
manifest says about it — read straight out of each jar, no network needed —
plus search and install from **Modrinth**, filtered to builds that support this
server's Minecraft version. Updates are found by each jar's checksum rather
than its filename, applied with one click after a plugins-scope snapshot, and
enable/disable renames the jar in place so a disabled plugin keeps its spot and
its config. `mcctl plugins <name>` is the same list for a terminal.

## Paper updates itself too

**Settings → Server software** checks PaperMC on demand: a newer build of your
version is one click, with the old jar kept in the folder as the way back.
Moving to a newer *Minecraft version* is deliberately harder — it migrates the
worlds one-way, so it asks you to type the server's name and takes a standard
snapshot first. `mcctl upgrade <name>` from the terminal.

## Scheduled restarts warn the players

A restart task can announce itself over the console — at the full figure, one
minute, and ten seconds — before it acts. Zero warning stays a real choice for
servers that restart while everyone is asleep.

## Smaller things

- `mcctl verify <name> [--all]` reads a snapshot back end to end — gzip
  checksums genuinely checked — and compares it against its manifest, so a
  backup that would fail on the day it mattered fails today instead. The first
  sweep of the machine it was written on found three.
- The core now has a test suite (90 tests, `npm test`) and CI on every push.
- `--no-open` and `--no-snapshot` are honoured instead of silently ignored.
