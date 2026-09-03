# Contributing

Thanks for wanting to improve mcctl. A few things worth knowing before you start —
they will save you time.

## What mcctl is, and is not

mcctl runs Minecraft servers on one person's Windows machine: no accounts, no cloud,
no Docker, and nothing exposed to a network without a deliberate decision. Features
that push it toward being a hosting panel — multi-node, user accounts, a remote web
UI — are out of scope on purpose. [ROADMAP.md](ROADMAP.md) says what is planned and
what has been deliberately declined; reading it first beats building something that
cannot be merged.

## Ground rules

- **Zero runtime dependencies.** The core is plain Node (>= 20) and ships nothing from
  npm. If a feature seems to need a package, it probably needs a smaller feature —
  the zip reader, the YAML-lite and the TOML-lite in `src/plugins.mjs` exist for
  exactly this reason.
- **No build step.** The panel is served from source; the wizard is loaded from disk.
- **Honesty over polish.** Errors name what went wrong and the way out. Nothing is
  silently capped, silently skipped, or silently retried.
- **Comments carry the why.** The codebase documents its reasoning next to the code —
  read a file's comments before reshaping it, and keep yours in the same voice.

## Working on it

```
git clone https://github.com/joogiebear/mcctl
cd mcctl
npm test                 # node:test, no dependencies, ~a second
node mcctl.mjs ui --no-open --port 8771    # the panel, from source
```

Tests live in `test/` and run on every push and pull request, on Windows (the run
that counts — the scheduler speaks schtasks and the paths are drive letters) and on
Linux (fast feedback). New behaviour that has a pure core should come with tests for
it; the existing files show the shape.

One rule that is easy to break without noticing: **nothing synchronous and slow on the
panel's request path.** The panel is one Node process, so a `spawnSync`, a
`readdirSync` walk of a world, or anything else that holds the event loop holds every
request and the console stream with it, and shows up for the person as the panel
hesitating. Use `execFile`/`spawn` and `fs.promises` there; `run/panel.log` records
every time the loop was held for more than a quarter of a second, so a regression is
visible.

## Branches

Two long-lived branches:

- **`dev`** is where work lands. Base pull requests on it and target it.
- **`main`** is what was last released. It moves only when `dev` is merged into it to
  cut a release, so checking out `main` always gives you the code behind the installer
  people have.

The desktop app updates itself from GitHub releases, not from branches, so nothing on
either branch reaches anyone until a release is published. `dev` is where a change
gets built and tried by hand first; the release is the gate.

## Pull requests

- Every commit message starts with a conventional type prefix (`feat:`, `fix:`,
  `docs:`, …), imperative mood, lowercase subject. Name a commit for the reason it
  exists, not its largest diff.
- One reason per PR. Small and focused merges fast; sprawling sits.
- CI must be green, and **every merge is reviewed and approved by the maintainer** —
  that is enforced by branch protection, not just etiquette.
- By contributing you agree your work is licensed under the repository's
  [MIT license](LICENSE).

## Releases

Releases are built, signed and published by the maintainer from a machine holding the
signing profile, from `main` after `dev` has been merged into it. CI runs tests; it
does not build installers. To try a build before it is released, run
`npx electron-builder --publish never` in `desktop/` on `dev` and install the result
by hand; it never touches GitHub.

### Betas

A version with a prerelease part, such as `0.10.0-beta.1`, is built and published from
`dev` with the same two scripts as a release, and `release:publish` marks it a GitHub
pre-release rather than latest. The two kinds of install sort themselves out: a stable
install asks GitHub for the latest release, which leaves pre-releases out, so nobody on
0.9.1 is offered a beta. An install that is itself a beta accepts newer betas and newer
stable releases alike, so it follows each beta and then moves to the stable release when
that is published. Install the first beta by hand; the rest arrive through the app.
