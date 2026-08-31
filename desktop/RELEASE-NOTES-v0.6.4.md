Modpacks update themselves

A server built from a modpack can now follow the pack. The **Mods** tab has a
Modpack card: check for a newer release, and update to it with one click —
`mcctl pack <name> update` from a terminal.

The order of operations is the feature:

1. **Everything new is downloaded and checksummed first** — the pack, its
   pinned Fabric loader, every server-side file — so a dead link or a release
   mcctl cannot run costs nothing but time.
2. **A standard snapshot is taken next**, so the way back exists before
   anything changes.
3. **Deletions are narrow**: only files the old pack owned that the new
   release dropped. Your worlds and the server's own files are protected even
   if the pack's records are confused, and anything you added by hand was
   never the pack's, so it is never touched.

A running server is refused outright — its files must not change under a live
JVM — and if the new release moves to a newer Minecraft version, that is said
plainly, because the worlds migrate on the next start. Mods that arrive with
the new release show up in the Mods tab at their new versions, still owned by
the pack. Players will need the matching new client pack, and the card links
it.
