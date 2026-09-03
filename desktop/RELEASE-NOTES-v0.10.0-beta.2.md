Notices that do something

Second pre-release of the panel pass. On top of beta.1:

## Notices under the vitals

- **A button for the way out.** "The port is already taken" offers *Change port…*, which opens
  the same dialog Manage does with the port filled in. Out of memory offers *Raise memory…*. A
  missing dependency or two plugins with one name opens Plugins; a Java that is too old, or a
  missing jar, opens Settings; a world that would not load opens Backups; a ticking crash opens
  the crash reports. The advice still says it in words for the terminal.
- **Show in console** switches to the console filtered to the exact line the finding was read
  from.
- **Dismiss.** Every notice can be closed for the run it belongs to. It comes back with the next
  run, because a port that was taken may be taken again.
- The crash notice and the state notes wear the same shape, and a stale state offers *Start*.
