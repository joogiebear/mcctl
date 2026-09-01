Worlds in hand

Until now the world was a name in server.properties and a folder mcctl walked
around. v0.7.0 makes worlds first-class, and pairs that with the two backup
features that keep them safe.

## A Worlds tab

Every world a server holds, listed with the active one named — which now also
shows in the server's vitals bar.

- **Import a downloaded map** from a zip, tar.gz or folder. The world is found
  wherever the download nests it, dimension folders come along, and nothing is
  ever overwritten: the map arrives as a new world and nothing changes until
  you make it the active one.
- **Export any world as a zip** — the format maps are actually shared in.
  The live world of a running server is refused (a torn copy wearing a healthy
  filename is worse than a refusal); take a backup instead, which flushes
  first.
- **Switch which world runs** with one click, stopped-server only, taking
  effect at the next start.
- **Delete a world** with the truth stated up front: only the active world is
  ever included in snapshots, so an inactive world has no way back unless it
  was exported first.

`mcctl worlds <name>` does all of it from a terminal.

## Snapshots on a second drive

Servers and their backups on one disk fail together. Backups → **Add a
mirror** points every new snapshot at a second location — ideally another
drive — copied as it is taken, with retention deletions following. A mirror
that cannot be written never fails the backup that just succeeded; it is
reported as exactly what it is. No restart needed, and
`mcctl config set-backup-mirror` from a terminal.

## Backups verified on a clock

The scheduler gains a **Verify the backups** action: every snapshot read back
end to end on whatever schedule you choose, with failures recorded in the run
log and delivered over the server's Discord webhook. A corrupt backup is found
the week it happened, not the day it mattered.
