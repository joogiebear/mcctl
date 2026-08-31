# mcctl

A local Minecraft server control plane for this machine. Manages multiple server
instances with detached launch, captured console, RCON command/response, stdin
injection, and snapshot/restore.

Zero dependencies — plain Node 20+ and the `tar` that ships with Windows.

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
- Generated instances default to `online-mode=false` because they are meant for
  local plugin testing. Any server that real players can reach should have
  `online-mode=true` — set it with
  `mcctl props <name> online-mode=true`.
- Nothing here opens firewall ports or touches your router. Exposing a server to
  the internet is a deliberate, separate decision.

## Notes

- JVM flags default to Aikar's G1 tuning, switching to the large-heap variant at
  12G and above. Override per instance with a `jvmFlags` array in
  `instances.json`.
- `start` truncates `run/<name>/console.log` each launch so `logs` shows the
  current run. The server's own `logs/` directory keeps the full rolling history.
- `tar` exits 1 with a warning when it skips a file the running server holds
  locked. That is expected on hot snapshots and is not treated as failure.

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
GH_TOKEN=<token> npm run release  # build + publish installer and latest.yml
```

Releases publish live, not as drafts. electron-builder defaults to `draft`, and a draft is invisible
to `electron-updater` — the release looks published on GitHub while no one is offered the update,
which is a confusing thing to debug weeks later. `releaseType: release` in the publish config is
what makes shipping one step instead of two.

Builds are **unsigned**. Auto-update works regardless, but Windows SmartScreen warns on first
install ("More info → Run anyway"). Signing is a certificate purchase, not a code change; the build
config is arranged so it can be switched on without rework.

### How updates behave

Checking, downloading and installing are three separate presses. Nothing downloads or installs on
its own — this app sits beside long-lived servers, and an update that restarts the window
unannounced is a surprise rather than a feature. Installing warns that running servers survive it,
because the honest answer is that only the window restarts.

Update checks are refused outside a packaged build: in development the version is whatever
`package.json` says and there is no installer to replace.
