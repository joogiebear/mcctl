Modded servers

mcctl now runs Fabric servers, and can build one from any server-ready Modrinth
modpack in one click. Modded servers are still vanilla underneath, so everything
you already have — crash auto-restart, webhooks, backups and verify, the
scheduler, the console, players — works on them unchanged.

## Fabric servers

**Add a server → Create a new one** has a Software choice: Paper runs plugins,
Fabric runs mods. The version list follows the choice, and the terminal grew
`mcctl new <name> --fabric <version>` to match. On a Fabric server the Plugins
tab becomes a **Mods** tab — same behaviour, different folder and vocabulary:
mods install from Modrinth filtered to Fabric builds for your version, manifests
are read out of each jar, and anything you drop in by hand is left alone.
(Hangar hosts no mods, so it sits this one out.)

## One click from modpack to server

**Add a server → From a modpack** searches Modrinth for packs a server can
actually be built from — server-installable, Fabric — and turns the chosen one
into a running server: every server-side file the pack lists downloaded and
checksummed **before the server exists**, the pack's exact Fabric loader
version pinned, its configuration applied, client-only files skipped and
counted. If anything fails partway, the half-built server is removed rather
than left looking created. `mcctl new <name> --modpack <slug>` does the same
from a terminal.

Mods that came with a pack are the pack's: the Mods tab shows them with a
Modpack tag, but never offers them individual updates — updating one mod out
from under its pack is how packs break. The tab also answers the question every
modded server gets asked: it names the pack and links the client pack your
players need to join.

## Smaller things

- Backups' plugins scope now covers a Fabric server's mods folder.
- The Server software (Paper update) card stays off servers that cannot run
  Paper builds.
- Archive extraction refuses any pack or zip entry that tries to write outside
  the server's own folder.
