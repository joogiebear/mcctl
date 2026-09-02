Says what went wrong, and a round of fixes

Two things in v0.8.0: the panel and the CLI now recognise the failures people
actually hit and say the fix, and a code review turned up a set of defects that
are now closed, several of them in paths nothing had ever tested.

## Log intelligence

The console already tells the truth, in a stack trace, at 3am, in vocabulary
only the JVM loves. mcctl now reads the same lines and answers the only
question anyone has: what is wrong, and what do I do about it.

- **Known failure shapes**, each with the fix: the port already taken, the EULA
  not accepted, Java too old for the server, out of memory, out of disk, a
  plugin or mod missing a dependency, two jars claiming one plugin, a corrupt
  world, a ticking crash, a watchdog stall, and a missing server jar.
- **Said wherever the failure surfaces.** A strip under the panel's vitals,
  advice printed by a failed `mcctl start`, a new `mcctl why <name>`, and the
  daemon's crash webhook naming the likely cause so a person woken by
  "crashed" does not have to open a log to learn "out of memory".
- **Minecraft's own crash reports** are listed beside the findings with their
  Description line, one click from the folder.

## Fixed

- **Rebuild deleted nothing on a server whose world was not called `world`.**
  The wipe list hardcoded the default names; it now reads `level-name`, the way
  the snapshot taken just before it already did.
- **Hot snapshots from the panel, the scheduler and the pre-upgrade step were
  unflushed.** The save-off / save-all / save-on sequence lived in the CLI's
  `backup` command only. It now happens inside every snapshot of a running
  server, and a flush that cannot be done is recorded in the manifest rather
  than silently skipped.
- **The panel could take itself down.** A route that failed after a console
  stream had started answered the error into a stream that already had
  headers, which crashed the process, and the desktop app's panel with it.
- **Refusals answered as server errors.** "The server is running" and "that
  is not a port" now come back as 400, not 500.
- **A reused pid read as a live server.** Windows hands process ids out again
  quickly; a daemon that died could report Running forever, and `kill` would
  have stopped a stranger. The daemon now records the executable behind each
  pid and a status read checks it.
- **Renaming from the panel left `start.bat` starting the old name**, and left
  the backup mirror's folder under it. Both follow the rename now.
- **Scheduled tasks broke for a Windows user with a space in their name.**
  The task's command was split at the space. The path is now quoted, verified
  by reading the created task back out of Task Scheduler.
- **`mcctl set <name> port=`** accepted anything and checked nothing; it now
  shares the panel's range and collision check.
- **The panel now says when it has lost contact with mcctl** instead of leaving
  every card at Running with Start and Stop enabled.
- **Creating a second server** without touching the loader posted the previous
  loader's version list. The form reloads it after a create.
- **The desktop app's release scripts** would have failed at the 31st release:
  the paginated listing was parsed one page at a time. Fixed before it hit.
- **Links opened from the panel** are held to https in every path, the top
  frame cannot be navigated away, and a cancelled navigation no longer pops an
  error box.
- The Backups and Scheduler tabs no longer start PowerShell on every load;
  the scheduler's answer is remembered for a few seconds.

## Tested for the first time

The daemon, the control pipe, ready detection, stop, crash recovery and kill
now have an end-to-end test that spawns the real daemon against a fake JVM,
alongside tests pinning each fix above. 147 tests, up from 134.
