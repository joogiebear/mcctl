# Plan: modded servers and Modrinth modpacks

Status: **planned, not started.** Written 2026-08-31, to be built after v0.6.2 has had
a hands-on test pass. Ships on the 0.6.x line — it extends the same content-installing
area the plugin manager lives in.

## The goal

`Add a server → From a modpack`: search Modrinth's modpacks, pick one, and get a
ready-to-run modded server — loader installed, mods downloaded and checksummed,
configs applied — the same one-click shape the plugin manager already has. Alongside
it, plain Fabric/NeoForge servers without a pack, for people who bring their own mods.

## Why it is bigger than a plugin source

Everything so far assumes Paper: one jar, `-jar server.jar --nogui`, a plugins folder.
Modded servers break each of those assumptions, so the work splits into phases that
are each shippable alone.

### Phase 1 — the loader becomes a fact about an instance

- Registry: each instance gains `loader` (`paper` — the default and the migration for
  every existing instance — `fabric`, `neoforge`, `vanilla`).
- The daemon builds its launch by loader. Fabric is easy: its server launcher jar runs
  with plain `-jar`. NeoForge is not: it launches via argument files
  (`java @user_jvm_args.txt @libraries/.../win_args.txt`), so the daemon needs a
  per-loader command builder. **Start with Fabric; NeoForge is its own step.**
- Ready/failure detection: confirm `Done (…s)!` against real Fabric and NeoForge
  output at build time rather than assuming Paper's line.
- What needs no change at all, because modded servers are still vanilla underneath:
  server.properties, EULA, RCON, the console, backups, snapshots and verify, the
  scheduler, crash auto-restart, webhooks, players. The supervision stack is
  loader-agnostic for free.
- What must scope itself by loader: the **Server software** card (Paper builds only),
  and the **Plugins** tab (below).

### Phase 2 — Modrinth modpacks (.mrpack), Fabric first

A `.mrpack` is a zip: `modrinth.index.json` (file list with per-file hashes, download
URLs, and a server/client `env` marker, plus the loader and Minecraft version it
needs) and `overrides/` + `server-overrides/` folders of config.

Install flow for the new Add-a-server tab:

1. Search Modrinth `project_type:modpack`, filtered to server-supported packs; pick a
   version (newest stable default, same as plugins).
2. Download the mrpack, read the index, refuse politely if it needs a loader Phase 1
   does not cover yet.
3. Install the loader the index names (Fabric's launcher via its meta API; NeoForge
   later via its installer's `--installServer`).
4. Download every file whose `env.server` is not `unsupported`, verify each against
   its hash, place by its `path`.
5. Extract `overrides/`, then `server-overrides/` on top.
6. Record the whole pack in a provenance file (`.mcctl-pack.json`, the plugin store's
   sibling): pack project, version, and the file list it owns.

That provenance record is what makes **pack updates** honest later: a new pack version
adds its new files, replaces its changed ones, and removes only files the OLD index
owned that the new one does not — never the worlds, never anything the person added.

### Phase 3 — the Plugins tab grows into a Content tab

On a `fabric`/`neoforge` instance the same tab manages `mods/` instead of `plugins/`:
Modrinth search with `project_type:mod` and the right loader facet, manifests read from
`fabric.mod.json` (the zip reader already does the hard part; NeoForge's `mods.toml`
needs a small TOML-lite the way plugin.yml got a YAML-lite). Two provenance classes:

- **Pack-owned mods**: shown, but updated only by updating the pack — individually
  updating one mod out of a pack is how packs break.
- **Added-by-mcctl mods**: exactly today's managed-plugin behaviour.
- **Hand-dropped mods**: exactly today's manual behaviour — left alone.

### Phase 4 — NeoForge

The argument-file launcher, the installer flow, `mods.toml` reading, and the same
mrpack path for NeoForge packs. Kept last because it is the most launch-machinery for
the least new product surface.

## Decisions already taken (so building can start without re-litigating)

- Fabric before NeoForge; each phase shippable alone on 0.6.x.
- Existing instances migrate by defaulting `loader: paper`; nothing asks them anything.
- Pack files are owned by the pack; the update path may only touch what the old index
  owned. Worlds and hand-added files are never the pack's to remove.
- A pack whose server files are hosted off-Modrinth gets the plugin manager's
  treatment: a link and honesty, not a pretend install.
- Client guidance is part of done: a modded server is only joinable with the matching
  client pack, so the panel should show the pack name, version and Modrinth link
  somewhere a person can read to their friends.

## Open questions (to settle when building starts)

- Java versions: older packs want Java 17, current ones 21+. `inst.java` already
  exists per instance; the question is whether creation should probe and warn, or
  fetch a runtime. Probe-and-warn first.
- Whether `vanilla` (no loader, no mods) is worth exposing while we are in there —
  probably yes, it is nearly free once `loader` exists.
- Memory defaults: modded servers want more than 2–4G; pack metadata sometimes says.
