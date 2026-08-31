The sections moved into a column

Six tabs across the top had run out of room. At the app's own 900px minimum they
needed more width than the strip had — the icons alone pushed **Settings** off the
end — and the fixes for that were a sideways scroll nobody would think to use and a
rule that hid the icons again. A column has neither problem, and room for a seventh
section.

It also gave the console back a row of chrome. The log measures **243px at 900×600
where it was 176px**, because the strip is no longer sitting between the server's
vitals and its content.

Below 780px the column becomes a row again. A 172px sidebar out of a narrow content
area is too much to spend on navigation, and that is the width where the old shape
was the better of two bad options.

## Every section says what it is

Each one opens with its mark, its name, and a line explaining what the screen is
for. The nav tells you where you are in one word; a sentence is the difference
between recognising a screen and working it out.

## Server settings are grouped

Nine fields in a single column meant reading all of them to find the one you
wanted. They are three cards now — who can join, gameplay, world and load — each
with a mark and a line saying what it covers.

The groups live beside the field definitions in the core rather than in the page,
so the two cannot drift apart. A field added without a group still appears, in a
section at the end, rather than quietly vanishing from the only screen that can
edit it.

## Players have faces

Generated from the UUID, not fetched. The usual way to do this is an avatar
service, and mcctl has to work with no network at all — so instead the UUID is
treated as what it already is: thirty-two hex digits of stable, well-distributed
noise. Eight of them choose a hue and the rest fill a mirrored five-by-five grid.
The same player gets the same face on every machine, forever, offline.

## Smaller things

- Automatic backups get a switch rather than a checkbox. A checkbox says "tick this
  to agree"; a switch says "this is on now", which is what a running schedule is.
- The lightning bolt on **Run now** is no longer clipped flat at both ends — its
  outline had been projecting outside its own bounds and every render sliced it off.
- The Performance tab's time-range picker no longer draws an empty bordered trough
  across the width of the pane.
- Keyboard focus on a section is a complete ring again rather than two stubs.
- Selecting a server in an orphaned or unknown state no longer loses its selection
  border.
- Player and snapshot rows now size themselves against the pane rather than the
  window, and put their buttons on their own line when it is narrow. The section
  column takes real width out of the content area, and at the app's minimum window
  size those rows had been collapsing — a UUID rendering one character per line, a
  snapshot's date and filename column at zero width.
- The automatic-backup switch shows keyboard focus. It was the one control in the
  app that lost the focus ring twice over.
- A pane holding nothing but an error can be reached by keyboard instead of skipped.
- The pane title stays put while you scroll.
- Leaving the Performance tab and coming back starts its polling again, which it
  had never done — the chart used to freeze until you reselected the server.
