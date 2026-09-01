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

Tests live in `test/` and run on every push and pull request (Windows runner — the
scheduler speaks schtasks and the paths are drive letters). New behaviour that has a
pure core should come with tests for it; the existing files show the shape.

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
signing profile. CI runs tests; it does not build installers.
