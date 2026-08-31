Four new tabs: Backups, Scheduler, Players and Performance.

Everything a server needs day to day is now in the app. The console has company.

## Backups

Take one at a chosen scope, or set a schedule and a limit and stop thinking about
it. The history shows every snapshot with its size, age and what it covers, and
each can be restored or deleted.

Restoring is refused outright while the server is running — extracting over files
a live server holds open corrupts a world rather than replacing it — and otherwise
asks you to type the server's name. The confirmation says what comes back and when
it was taken.

You can also move where snapshots are kept. Existing ones stay where they are, and
the app says so rather than letting a history appear to vanish.

## Scheduler

Backups, restarts and console commands on a clock, run by Windows Task Scheduler,
so they happen whether or not the app is open — while you are signed in, screen
locked included, but not after you sign out. The app says that rather than leaving
it to be discovered at 3am.

Each task shows what it does in a sentence rather than in `schtasks` flags, when it
runs next, and how the last run went. Underneath is a log of what actually
happened, which is the half Windows cannot give you: Task Scheduler records an exit
code, so `0` is all it can say about a backup, while mcctl's own line names the file
it wrote.

Runs have three outcomes, not two. A nightly warning whose server happened to be
down did not fail — there was nothing to send — and it reads as skipped.

## Players

Everyone the server knows about, gathered from all five places it records them:
operators, bans, the whitelist, the name cache, and the world folder itself. Search
by name or id, filter to operators or the banned, and op, ban or delete a player's
world data from the row.

Whoever is connected right now is marked and sorted to the top — asked of the
server, because nothing on disk knows it. A player's file is not written until they
log out, so a screen reading only files says "has never joined" about the person
standing in front of you.

Changes go through the running server's console when it is up and into its files
when it is not, decided for you. Getting that backwards is invisible: the app would
say "opped" and the next restart would quietly disagree.

## Performance

Processor and memory over the last minute, five minutes, half hour, hour or four
hours, sampled every ten seconds while the server runs.

Both scales follow the data. A fixed 0–100% processor axis draws every ordinary
server as a flat line on the floor. Memory is labelled as the heap ceiling rather
than as what the server was "given", and says so when the process goes above it —
`-Xmx` caps the heap, the graph is the whole java process, and being above that line
is ordinary rather than a problem.

## Fixes that matter

A few of these were found by an adversarial review of the new code, and two of them
were in features shipped earlier the same day.

- **Retention deleted snapshots it did not create.** A scheduled backup keeping five
  would delete a `pre-rebuild` snapshot — the only copy of a world taken before it
  was wiped — within five hours of it being made. A limit now only counts and removes
  the snapshots its own task produced.
- **Two backup schedules shared one pool.** A nightly keeping 7 and a weekly archive
  keeping 8 each pruned the other's work, so the smaller limit always won and the
  archive could never accumulate eight weeks of anything.
- **The automatic-backup toggle could delete a task you wrote.** It found its schedule
  by "any backup task on this server", which stopped being unique the moment the
  Scheduler tab existed. It now marks and finds its own.
- **A scheduled restart reported success over a server that died.** It recorded
  "restarted" the moment the process existed; a server that fell over eight seconds
  later on a broken plugin still reported success. It waits for the answer now.
- **Renaming a server orphaned its snapshots and schedules.** The backups stayed
  filed under the old name and the tasks kept firing at a server that no longer
  answered to it. Both follow the rename; deleting a server takes its schedules with
  it.
- **Changing a server's version recorded a jar it had not placed**, so the next start
  failed on a path that never existed. The jar is put where the server runs it from
  before anything is recorded, and older jars left behind are reported rather than
  silently deleted — they are how you go back.
- **Task times were read in the machine's locale.** Anything not formatting dates the
  American way showed raw text where a date belonged. The same applied to the new
  performance sampler, where a comma decimal separator would have made 29.7% read as
  29%.
- **Any page on loopback counted as first-party.** The origin check compared hostname
  but not port, and this machine is full of them — dynmap, BlueMap and Plan all serve
  web UIs on their own ports while rendering text players chose.
- **The server view ran off the right edge at 900×600**, the app's own minimum window
  size, taking Manage and the console's Clear button with it.

## Also

- The console moved into a tab, so a server's screen has room for the rest.
- Snapshots can live outside the data root, and a single one can be deleted.
- A scheduled backup's retention limit is now actually applied. It was recorded and
  never read, so automatic backups grew until the disk filled.
