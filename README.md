# mcctl

A local Minecraft server control plane for this machine. Manages multiple server
instances with detached launch, captured console, RCON command/response, stdin
injection, and snapshot/restore.

Zero dependencies — plain Node 20+ and the `tar` that ships with Windows.

## What you need

- **Java 21 or newer.** This is the one thing mcctl cannot supply: Minecraft servers *are* Java
  processes. [Temurin 21](https://adoptium.net/temurin/releases/?version=21) is a good default.
  The desktop app checks for it on first run and the panel says so in a banner if it is missing;
  `mcctl doctor` reports it from the command line.
- **Node 20+**, for the CLI. The desktop app carries its own runtime and does not need it.
- **Windows 10/11** for the desktop app. The CLI runs anywhere Node does.

## Why this exists

A Minecraft server is an interactive foreground process. Launched from a normal
shell call it blocks forever, its stdin is unreachable, and its console output is
lost. That makes the ordinary edit-restart-check loop painful to automate.

`mcctl` puts a supervisor in front of each server so short-lived commands can
start it, read what it printed, talk to it, and shut it down cleanly.

## Quickstart

```bash
node mcctl.mjs list
```

Register a server directory you already have, in place — nothing is moved or
rewritten, and its existing ports and RCON password are read from its own
`server.properties`:

```bash
node mcctl.mjs adopt survival "S:\Claude\minecraft\Server" --memory 6G
```

Start it and wait until Paper reports ready:

```bash
node mcctl.mjs start survival
```

Talk to it:

```bash
node mcctl.mjs cmd survival "tps"
```

Spin up a disposable copy of its plugins and config on its own port, with fresh
worlds, for reproducing a bug without touching the real server:

```bash
node mcctl.mjs clone survival ecotest && node mcctl.mjs start ecotest
```

On Windows `mcctl.cmd` wraps the above, so `mcctl list` works once this folder is
on your PATH.

## Commands

### Lifecycle

| Command | Does |
| --- | --- |
| `list` | Every instance with status, ports, memory, uptime |
| `status <name>` | Detail for one instance, including pids and level-name |
| `start <name>` | Launch and block until the server reports ready |
| `stop <name>` | Graceful shutdown by writing `stop` to the console |
| `restart <name>` | Stop, then start |
| `kill <name>` | Force-kill the process tree |

`start` flags: `--detach` (return as soon as the process launches),
`--timeout <sec>` (ready timeout, default 180), `--no-sync` (leave
`server.properties` alone instead of pushing registry ports into it).

If the server fails to reach ready, `start` prints the last 25 console lines and
exits non-zero, so a failed launch is self-diagnosing.

### Console

| Command | Does |
| --- | --- |
| `logs <name> [-n 60] [-f] [--grep re]` | Read the captured console; `-f` follows |
| `cmd <name> "<command>"` | Run over RCON and print the reply |
| `send <name> "<line>"` | Write a raw line to the server's stdin |
| `console <name>` | Interactive attach; `/detach` leaves the server running |
| `players <name>` | Who is online |

`cmd` goes over RCON and gets a reply back, which is what you want almost always.
`send` writes to stdin and gets no reply, which is what you want for anything
RCON refuses to carry.

### Instances

| Command | Does |
| --- | --- |
| `adopt <name> <dir>` | Register an existing server directory in place |
| `new <name>` | Create a fresh instance (`--jar`, `--template`, `--accept-eula`) |
| `clone <src> <new>` | Copy plugins and config into a new instance on a free port |
| `set <name> key=value` | `memory`, `java`, `jar`, `port`, `rcon.port`, `rcon.password` |
| `props <name> [key=value]` | Read or edit `server.properties` |
| `rm <name> [--purge --yes]` | Unregister, optionally deleting the files |

`clone` gives fresh worlds by default; pass `--with-worlds` to copy world data
too. Ports are allocated automatically from 25565/25575 upward, skipping anything
already claimed in the registry or in use on the box.

### Snapshots

| Command | Does |
| --- | --- |
| `backup <name>` | Snapshot to `backups/<name>/` |
| `snapshots <name>` | List snapshots |
| `restore <name> [ref] --yes` | Restore (default `latest`); server must be stopped |
| `prune <name> --keep <n>` | Delete all but the newest n |

Scopes: `plugins`, `worlds`, `config`, `standard` (the default — plugins, the
active world set, and config), `full` (everything except `cache/`, `libraries/`,
`versions/`, `logs/`).

Backing up a running server issues `save-off` / `save-all flush` over RCON first
and `save-on` afterward, so a hot snapshot is coherent rather than a torn copy
of a world mid-write.

`restore` refuses without `--yes` and prints what it would overwrite.

### Other

| Command | Does |
| --- | --- |
| `templates` / `templates save <inst> <tpl>` | Reusable plugin+config sets |
| `jars` / `jars import <path>` | Server jar store used by `new` |
| `doctor` | Environment, port collisions, EULA, disk, stale state |

## How it works

```
mcctl (short-lived CLI)
   │
   ├─ spawns detached ──▶ src/daemon.mjs (one per instance)
   │                        │
   │                        ├─ owns the java child process
   │                        ├─ mirrors stdout/stderr ──▶ run/<name>/console.log
   │                        └─ listens on \\.\pipe\mcctl-<name>
   │                              ops: ping | send | stop | kill
   │
   ├─ reads run/<name>/state.json  (pids, ports, start time)
   ├─ reads run/<name>/console.log (logs, ready detection, follow)
   └─ connects to RCON on 127.0.0.1 (cmd, players, save flush)
```

The daemon exists because the CLI is short-lived and the JVM is not. It holds the
pipe to the server's stdin for as long as the server runs.

State is reconciled against live pids on every read, so a daemon that dies takes
its instance to `stale` (cleaned up automatically) rather than reporting
`running` forever. A java process that outlives its daemon shows as `orphaned`
and `kill` will clean it up.

`instances.json` is the source of truth for ports and RCON. `start` pushes those
values into `server.properties` before every launch, so hand-editing the file
cannot silently desync an instance from what mcctl believes about it. Pass
`--no-sync` if you want the file left alone.

### Layout

```
mcctl/
├── mcctl.mjs           CLI
├── mcctl.cmd           Windows shim
├── instances.json      Registry: ports, memory, RCON credentials  (gitignored)
├── src/
│   ├── daemon.mjs      Per-instance supervisor
│   ├── supervisor.mjs  start/stop/kill/ready-detection/log tailing
│   ├── control.mjs     Named-pipe client, state reconciliation
│   ├── rcon.mjs        Source RCON protocol client
│   ├── registry.mjs    Instance registry, Aikar JVM flags
│   ├── backup.mjs      tar-based snapshots
│   ├── create.mjs      new/clone/adopt/templates/jars
│   ├── props.mjs       server.properties reader/writer (preserves comments)
│   └── util.mjs        Ports, pids, tables, formatting
├── instances/          Instance data for servers mcctl created
├── templates/          Saved plugin+config sets
├── jars/               Server jar store
├── backups/            Snapshots + manifests
└── run/                Per-instance state.json, console.log, daemon.log
```

Instances that were `adopt`ed keep living wherever they already are; only their
runtime state lands in `run/`.

## Security posture

This is built for **localhost and LAN only**.

- RCON binds to whatever `server-ip` says; leave it empty for LAN or set it to
  `127.0.0.1` to keep RCON strictly local. RCON has no rate limiting or
  encryption and must never face the internet.
- `instances.json` stores RCON passwords in plaintext and is gitignored. So are
  `backups/`, `jars/`, `instances/`, and `run/`.
- Generated instances default to **`online-mode=true`**. That was `false` until v0.2.3, on the
  reasoning that a scratch server is for testing — but offline mode gives players name-derived
  UUIDs rather than Mojang ones, so any plugin keying data by UUID behaves differently: some bugs
  will not reproduce, and some appear that do not exist on a real server. Paper also prints a
  four-line `OFFLINE/INSECURE` banner near the top of every log, and plugin authors routinely
  refuse a bug report carrying it. A tool for reproducing plugin bugs should not produce reports
  that get thrown out on sight.

  Offline is still one toggle away, for multi-account testing or working without internet:
  `mcctl new <name> --offline`, `mcctl props <name> online-mode=false`, or the panel's
  **Settings…** on a server. The panel badges any server running that way.
- Nothing here opens firewall ports or touches your router. Exposing a server to
  the internet is a deliberate, separate decision.
- The panel is an **unauthenticated local HTTP server that can start processes and type into a
  server console**. Binding to `127.0.0.1` stops other machines reaching it; it does not stop the
  browser already on this one. So every request must also carry a loopback `Host` — which is what
  defeats DNS rebinding, since the attacker's own hostname is what arrives in that header — and a
  cross-origin request is refused outright. Requests with no `Origin` (the panel's own fetches,
  curl, the CLI) are allowed, because that is what a first-party request looks like.
- The page never receives an RCON password. Every route that returns an instance strips it first,
  so it cannot end up in a browser cache, a screenshot, or a pasted bug report.

## Notes

- JVM flags default to Aikar's G1 tuning, switching to the large-heap variant at
  12G and above. Override per instance with a `jvmFlags` array in
  `instances.json`.
- `start` truncates `run/<name>/console.log` each launch so `logs` shows the
  current run. The server's own `logs/` directory keeps the full rolling history.
- `tar` exits 1 with a warning when it skips a file the running server holds
  locked. That is expected on hot snapshots and is not treated as failure.

---

## The panel

```bash
node mcctl.mjs ui        # opens http://127.0.0.1:8770 in your browser
```

One HTML file, served by Node's own http module. No framework, no build step, no npm packages —
the panel that ships is the file in `src/ui.html`, and it works offline because nothing is fetched
from anywhere.

The same page runs in a browser tab and inside the desktop app. `window.mcctlDesktop` exists only in
Electron, and everything that depends on it is additive: a Browse button beside a path field, a
Settings screen that can move the data folder, update checking. In a browser those simply are not
there, and nothing else changes.

What it does:

- **Servers** — a card each, with a status lamp, the port, the memory and a live uptime that ticks.
- **Console** — search, filter to warnings or errors, pause, copy, wrap and a bounded scrollback.
  Log level shows as a coloured rail in the gutter rather than by recolouring the text, so ERROR
  stands out without becoming harder to read. A stack trace inherits the level of the line above it,
  which is what makes "filter to errors" show the whole failure instead of its first line.
- **Adding a server** — either create one, which downloads Paper and reports real progress, or point
  mcctl at a folder you already have. Nothing is moved; existing ports and the RCON password are
  read from that folder's own `server.properties`.
- **Renaming, resetting and deleting** ask you to type the server's name. That friction is
  deliberate: a dialog that only says "are you sure" gets answered reflexively.
- **Changing who can join** on a world that already has players warns first. Minecraft derives an
  offline UUID from the player's name and uses the real Mojang one otherwise, so flipping this
  hands everybody a different identity — permissions, homes, inventories and anything else a plugin
  keyed by UUID stay attached to the identity nobody has any more. The panel reads the world's
  `playerdata` directory, tells the two kinds of UUID apart by version, and says how many players
  are affected before you decide.
- **Settings…** edits the part of `server.properties` people actually change — who can join,
  MOTD, difficulty, game mode, max players, PvP, whitelist, view distance, spawn protection.
  Everything else stays in the file for `mcctl props` or an editor, and nothing the panel writes
  disturbs another key or a comment.

The panel is bound to `127.0.0.1` and refuses any request whose `Host` is not a loopback address, or
whose `Origin` is another site. It can start processes and type into a server console, so "local"
has to mean local rather than merely reachable — see [Security posture](#security-posture).

---

## Desktop app

A window around the same panel, plus a native folder picker and first-run setup.

```bash
cd desktop
npm install
npm start                  # runs the bundled core
npm start -- --core ..     # develop against this checkout (or set MCCTL_CORE)
```

The core runs **inside** the Electron process. Electron is already a Node runtime, so importing
mcctl directly is what bundling means here: one process, no second Node to ship, and no orphaned
child if the window dies.

Closing the window does **not** stop your servers. They are detached daemons that do not belong to
the app.

### Releasing

Installers and the update feed go to **`joogiebear/mcctl-releases`** (public). The source repo stays
private — `electron-updater` needs a readable feed, and the alternative is embedding a GitHub token
in every copy of the app, where anyone who downloads it can extract it.

```bash
cd desktop
npm version patch                 # bump; the app reports this version
GH_TOKEN=<token> npm run release  # build, sign, upload as a DRAFT
npm run release:publish           # check it is whole, then make it live
```

**Two steps, deliberately.** Both one-step options fail, and this project has now seen each:

- Publishing **live** means a failed upload leaves a release tagged, live and marked latest with
  nothing to download and no update feed. That happened on v0.2.6 — the blockmap uploaded, the
  111 MB installer did not, and a client checking for updates in that window got a 404.
- Publishing as a **draft and leaving it** means the release looks published on GitHub while
  `electron-updater` cannot see it at all, so nobody is offered the update and nothing says so.

So the build uploads a draft, and `release:publish` makes it live only after confirming the things
whose absence caused the first failure: all three assets present, uploaded and non-empty, and
`latest.yml` naming this version with a size matching the installer actually up there. It refuses
and exits non-zero otherwise.

Builds are signed through **Azure Artifact Signing** (formerly Trusted Signing), configured under
`win.azureSignOptions`. That publishes under a validated individual identity, which is what turns
"Unknown publisher" into a name.

It does **not** make SmartScreen go away immediately. SmartScreen is a reputation system, not a
signature check, and reputation accrues to the publisher identity through real installs — so a new
publisher still gets warned about. EV certificates used to grant reputation automatically; Microsoft
removed that in 2024. Keep telling people about **More info → Run anyway** until the reputation
builds.

Signing needs, on the build machine:

- the **.NET SDK** — electron-builder installs a `dotnet` tool to do the signing, and fails with
  "No .NET SDKs were found" if only the runtime is present
- **`az login`**, against the tenant holding the signing account. Note that MFA is enforced for
  Azure Resource Manager, and a bare `az login` fails against such a tenant because it tries to
  acquire tokens silently — use `az login --tenant <id>`, which authenticates interactively.
- the **Artifact Signing Certificate Profile Signer** role. Being subscription Owner does not
  include it; identity validation does not include it either. It is assigned separately, and its
  absence is the last thing that bites before a first successful signature.

Certificates live about **three days** and rotate automatically, which is why every signature is
timestamped — without one, everything already shipped would stop validating within the week rather
than staying valid for the moment it was signed in. `npm run verify` treats a missing timestamp as
a failure for exactly that reason.

### Tests

```bash
cd desktop
npm test
```

Covers window-state.js, which decides whether a remembered window position is still somewhere a
person can reach. That decision depends on which monitors are attached — the thing you cannot
arrange on the machine running the test — so the module takes the display list as an argument and
the test passes it fictional ones, including the case that matters: a window last seen on a second
monitor that is no longer plugged in.

### Checking a build before shipping it

There is no CI on this repository, so the build checks itself:

```bash
cd desktop
npm run pack      # builds; afterPack fails it if the result is wrong
npm run verify    # re-checks a build that already exists, icon included
```

The check covers the things that have gone wrong silently before — the app icon not reaching the
executable, the core not being copied into `resources`, a file added to `desktop/` and forgotten in
the `files` allowlist, and a signature that is missing, invalid or untimestamped. `afterPack` runs during the build itself, so a bad build throws before an
installer is made and long before anything is published.

### How updates behave

Checking, downloading and installing are three separate presses. Nothing downloads or installs on
its own — this app sits beside long-lived servers, and an update that restarts the window
unannounced is a surprise rather than a feature. Installing warns that running servers survive it,
because the honest answer is that only the window restarts.

Update checks are refused outside a packaged build: in development the version is whatever
`package.json` says and there is no installer to replace.
