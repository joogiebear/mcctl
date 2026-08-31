Your own plugins are yours

The Plugins tab in v0.6.0 listed every jar in the folder, which claimed a say
over jars it had no business managing: a custom build or a premium plugin
bought elsewhere would never show an update there, and the update check was
sending its checksum to Modrinth to ask about it.

mcctl now records what it installs, and manages exactly that:

- The Plugins tab lists **only what mcctl installed**, with one line counting
  the jars you added by hand — they load as normal and are left alone.
- **Check for updates** looks only at mcctl-installed jars. The checksum of a
  hand-added plugin never leaves your machine.
- The update button refuses a jar mcctl did not install, even if asked
  directly.
- `mcctl plugins <name>` remains the full inventory for a terminal, with a
  SOURCE column saying which jars are mcctl's to update and which are yours.

The record lives beside the jars and rides along in plugins-scope snapshots,
so a restore keeps it consistent. It follows a rename and dies with a delete.

One note for the hours v0.6.0 was live: anything installed from the Plugins
tab in that version predates the record, so it will show as hand-added.
Installing it again from the tab (same search, one click) adopts it.
