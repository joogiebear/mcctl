The panel stops hesitating

The panel is one process, and four things it did held that process outright:
listing the process table on every poll while a server ran, starting PowerShell
to ask the scheduler whenever the Backups or Scheduler tab opened, walking every
file of every world when the Worlds tab opened, and asking Java its version the
moment the page loaded. Each one froze every request and the console stream for
as long as it took - anything from a third of a second to several - which read
as the whole panel stuttering. None of them does now.

## Performance

- **The process table refreshes in the background.** The first read is
  still immediate; every later one answers from the table it has and updates
  quietly behind it.
- **The scheduler is asked asynchronously**, once for a burst of requests,
  and a task changed while a query was in flight never shows its old state.
- **World sizes come from a walk that does not hold the panel.**
- **The Java check no longer blocks the page opening**, and it reports the
  version line rather than a `JAVA_TOOL_OPTIONS` notice when that is set.

## Java, found where it is

- **"Java is not installed" is no longer said to people who have it.** mcctl
  looks in the usual install folders - Program Files, the per-user Programs
  folder, `JAVA_HOME` - as well as PATH, so a Java the installer did not put
  on PATH, or one installed after mcctl was already open, is found and used.
- **Each server chooses its own Java.** A Java card in the server's Settings
  tab lists every Java on the machine, or takes a path to one it did not
  find. A test server for 1.20.4 can run on 17 while the one beside it runs
  26.x on 25. A new server defaults to the newest usable Java found.
- **mcctl knows what each version needs.** The version list in Add a server
  says "Java 21" or "Java 25" beside every version, and warns underneath when
  nothing installed is new enough - before the download, not after it. A new
  server gets the newest installed Java that fits its version, so 1.20.4
  lands on 17 and 26.x on 25 without anyone choosing. A version nothing here
  can run is refused with the download link, and "Create anyway" is one click
  for whoever is about to install it.
- **Start checks the Java first.** A server whose Java cannot be run is
  refused by name, with the way out, instead of dying fifteen seconds later
  with `spawn java ENOENT` in a state file. A Java that is certainly too old
  for the server's version is refused the same way, or swapped for one that
  fits when the server was on plain `java`; `mcctl start --force` overrides.
- `mcctl doctor` and the diagnostics list every Java found.

## Reporting a problem

- **Feedback**, in the header. *Something broke* opens a GitHub bug report
  with the version, Java, server status and panel log already in it, and puts
  the full diagnostics on the clipboard to paste under it. *An idea or a
  question* opens the project's discussions. Nothing is sent from mcctl on
  its own; the browser hop is the consent. A crash notice under a server's
  vitals has a **Report** link that does the same, named for the crash.
- **Settings → Copy diagnostics** puts a bug report's worth of facts on the
  clipboard: version, Java, where things live, every server's status, the
  panel's own log and the selected server's last console lines. Never an RCON
  password or a webhook URL.
- **`run/panel.log`** records every time the panel was held up for more than
  a quarter of a second, and any failure the panel process swallowed - which
  it now does instead of closing on one.
- A bug-report template on GitHub asks for the diagnostics.

## Also

- The drawn radio buttons - in the Manage dialog and the create form - are round
  again, with the dot in the middle. The shared field padding had been stretching
  them into a pill and pushing the dot into a corner.
- The README says why the panel cannot be bound to another address.
- CI runs the test suite on Linux as well as Windows.
