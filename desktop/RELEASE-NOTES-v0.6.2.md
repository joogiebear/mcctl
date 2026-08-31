Hangar joins Modrinth

The Plugins tab now searches **Modrinth and Hangar together** — plenty of
Paper-ecosystem plugins publish on PaperMC's own platform and nowhere else.
Every result and every installed row names its source, and if one platform is
down you get its error as a note beside the other's results, never instead of
them.

Hangar works a little differently, and mcctl says so rather than papering over
it:

- Some projects host their downloads elsewhere (premium plugins especially).
  Those cannot be one-click installed, so mcctl gives you the link instead —
  and once you drop the jar in by hand, it is yours: never listed as managed,
  never offered updates, never hashed to anyone.
- Hangar's supported-version lists are sparse and hand-maintained. An exact
  match for your server's version wins; otherwise the newest downloadable
  build is offered **with the mismatch stated** — "its author claims 26.1.2,
  not your 26.2" is information you should have, not a reason to show nothing.

Installs are checksum-verified against what Hangar publishes, and updates for
Hangar-installed plugins compare the version mcctl recorded at install time
against the newest release — one unreachable project skips its own row rather
than failing the whole check.
