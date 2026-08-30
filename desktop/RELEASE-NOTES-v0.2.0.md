A UI release, and — it turned out — a repair job.

## Before anything else

**Start did not work in v0.1.0's installed build.** The supervisor launched each server's daemon
with `process.execPath`, which is `node` from the CLI and `mcctl.exe` inside the app. Handing an
Electron binary a script path launches a second copy of the application, so nothing started, nothing
was logged, and fifteen seconds later you got a modal pointing at a log file that had never been
written. It worked from the command line, which is why it shipped.

**Rename, Reset and Delete were dead buttons.** They confirmed with `prompt()`, which Electron does
not implement.

**Snapshots had never once succeeded on a machine with Git for Windows installed.** `tar` resolved
through PATH and found GNU tar, which reads `C:\backups\x.tar.gz` as a hostname and tries to open a
network connection to it. And on any machine, a snapshot of a *running* server produced a zero-byte
file that was recorded as a success — which matters, because Reset and Delete both take one first
and are only safe because it exists.

If you installed v0.1.0, update.

## The panel

Rebuilt around the screen a new user actually lands on: no servers. That state used to be a large
empty console, a command box with nothing to send commands to, and a row of buttons that all
refused. It now asks one question with two answers — create a server, or point mcctl at one you
already have.

- **Servers** are cards with a status lamp and a live uptime, so a running panel looks like one.
- **The console** got search, filter to warnings or errors, pause, copy, wrap, jump-to-newest and a
  bounded scrollback. Log level shows as a coloured rail in the gutter rather than by recolouring
  the text, and a stack trace inherits the level of the line above it — so "filter to errors" shows
  the whole failure instead of its first line.
- **Adding a server** either downloads Paper with real progress, or registers a folder you already
  have. Nothing is moved; its existing port and RCON password are read from its own
  `server.properties`.
- **Destructive actions** ask once, in one dialog, with named options — no more OK/Cancel standing
  in for "keep plugins" versus "wipe them". Typing the server's name is still required, on purpose.
- **Settings** shows where everything lives and can move the data folder.

## First run

The installer no longer asks where to install, so the wizard is the only location question and says
which one it is. It also checks for Java before anything is downloaded, rather than letting that
surface as `spawn java ENOENT` after a 50 MB download. (#1)

## And an icon

v0.1.0 shipped Electron's default atom. mcctl now has its own.

## Also fixed

- The RCON password was returned by every start, stop, restart and settings call. It is stripped
  everywhere now.
- The panel refuses requests that are not addressed to localhost. It is an unauthenticated local
  server that can type into a server console, so any web page could previously reach it.
- A failed start reported success over a console full of the reason it had not.
- Rename could lose an instance from the registry after moving its directory.
- Generated `start.bat` launchers called `node`, which the desktop app never required you to have.
- The console grew a DOM node per line forever.

## Installing

Windows will show SmartScreen — "Windows protected your PC" — because the build is unsigned.
**More info → Run anyway.** That is expected and will stay until the app is code-signed.

Needs **Java 21 or newer** to run servers. The app checks and tells you where to get it.
