Share the log, and the first outside contributions

The console can now leave the machine when you want it to, and this is the
first release with changes from outside the project. Console export and line
numbers are by @CallumJohnson.

## Console

- **Export.** Save the console to a `.log` file beside the server's
  snapshots, or upload it to mclo.gs, the log-sharing service plugin
  developers ask for, and open the link. The upload happens only after a
  dialog that says what is in it: mcctl replaces your account name in file
  paths first, mclo.gs removes IP addresses on its side (best effort, by its
  own policy) and deletes the log 90 days after it was last opened, and
  everything else goes as is. The delete token is kept in `run/mclogs.json`.
- **Line numbers**, toggleable and remembered.
- **The name to type when deleting a server** is shown in its own case. The
  label had been styling it uppercase while the check was exact, so
  `survival` was shown as SURVIVAL and never matched. Reported in #8.

## Around the project

- Every release now names its contributors: GitHub appends the merged pull
  requests with their authors under these notes, and a "New Contributors"
  line for first-timers.
- A project page, and banner artwork for partner sites.
