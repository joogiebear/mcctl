The panel, polished

Every screen of the panel got the same treatment. Some sections had been drawn with care and
others in a hurry, and the difference showed. This release closes the gap, and adds a few
things the panel should always have had.

## The server list folds to a rail

A control in the list's header collapses it to a strip of lamps. Every server's state stays in
view, the selected one stays lit, and hovering a lamp names the server. The add button becomes
a plus. The fold is your choice and is remembered. In a narrow window the folded list is one
short row, so the console gets nearly the whole window.

## Notices that do something

A finding under the vitals used to say what was wrong and, in prose, where to go about it. Now
it carries the button:

- *Change port…* on "The port is already taken" opens the same dialog Manage does, with the
  port filled in. Out of memory offers *Raise memory…*. A missing dependency or two plugins
  with one name opens Plugins; a Java that is too old, or a missing jar, opens Settings; a
  world that would not load opens Backups; a ticking crash opens the crash reports.
- **Show in console** switches to the console filtered to the exact line the finding was read
  from.
- **Dismiss.** Every notice can be closed for the run it belongs to. It comes back with the
  next run, because a port that was taken may be taken again.
- The crash notice and the state notes wear the same shape, and a stale state offers *Start*.

## Settings

- **One Save.** The crash card and the Java card no longer carry their own Apply. One button
  writes everything, says how many changes are waiting, and is disabled when nothing is.
- **It stays in view.** The save bar sticks to the bottom of the pane while you scroll, the way
  the title sticks to the top.
- Cards in a row share a bottom edge, and the automatic-backup row on Backups wraps between
  phrases instead of through one.

## Keyboard

- **Escape closes every dialog**, including Manage. It had been ignored there.
- Closing Add a server, Settings or Feedback puts focus back on the button that opened it,
  instead of dropping a keyboard user at the top of the page.

## Empty screens

- **Performance draws itself empty**: both gauges with their grids and the reason written across
  the chart, instead of a sentence where the charts will be.
- Scheduler shows one empty state rather than two stacked.
- Performance and the plugin search use the same empty state as every other pane.

## Underneath

- **The vitals strip wraps evenly** into equal cells, the jar name keeps two of them, and a
  partial last row stays plain - instead of one fact alone on a stretched second line.
- **Every size, gap, radius and tone is on a token.** Seventeen font sizes became a seven-step
  scale, spacing sits on a four-pixel grid, and the state colours stop being pasted hex. The
  visible effect is small on any one screen and adds up across all of them.
- The panel was tried as two pre-releases first. A version with a prerelease part is now
  published as a GitHub pre-release, which only installs that are themselves a beta are
  offered; stable installs never see one.
