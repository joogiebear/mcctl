mcctl is now SpawnLoft

Same program, new name. The desktop app, the panel, the installer and the
site are SpawnLoft; the site is at [spawnloft.com](https://spawnloft.com).
The command-line tool inside it is still `mcctl`, and so is the repository,
so every command you know still works exactly as typed.

## Upgrading

- **Install over the top.** The setup replaces the old `mcctl` program folder
  with a `SpawnLoft` one and renames the shortcuts. The app updates itself to
  this release the same way it always has.
- **Everything you have stays where it is.** Servers, worlds, backups, jars
  and settings live in the same folders under the same names. Servers that
  are running keep running through the upgrade; the window opens where you
  left it, and the first-run screen does not come back.
- **Scheduled tasks and launchers follow the program.** The batch file behind
  each scheduled task, and the start/console/stop launchers in each server
  folder, named the old executable by its full path. They are rewritten the
  first time the panel opens after the upgrade, so tonight's backup still
  runs and a double-click still starts the server. The same happens if the
  program folder is ever moved by hand.

## Around the project

- The project page and the docs have moved to
  [spawnloft.com](https://spawnloft.com), in their own repository. The old
  page sends visitors on.
