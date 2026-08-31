A visual pass over the whole panel

Everything was one surface with a one-pixel border. Server cards measured the same
colour as the panel holding them — `rgb(20,24,35)` on `rgb(20,24,35)` — so a card
read only by its outline, and a list of servers looked like a list of strings
rather than machines with states.

**Cards now sit above their panel**, `--edge` marks whatever has your attention, and
a fifth surface that had been pasted around as a raw hex is a token.

**Icons.** Nineteen of them, in one inline sprite referenced with `<use>`, so they
are defined once and inherit the colour of whatever they sit in — a Delete button's
icon turns red without anything saying so. Below 1000px they come off the tabs: six
labels alone need almost exactly the width the strip has at the app's minimum
window size, and a control you have to scroll sideways to find is worse than one
without a picture beside it. The strip scrolls too, so nothing is ever unreachable.

**One shape for "pick one of these."** The console's level filter, the player
filters and the performance ranges were three sets of plain buttons doing the same
job and looking like three different things.

**The server header splits its verbs from its destinations** — Start, Stop, Restart,
then a divider, then Open folder and Manage. Five identical buttons made the one you
wanted as hard to find as the four you did not.

**The vitals strip is cells** with hairlines between them, rather than a run of
label-value pairs that read as a debug dump.

**Empty panes carry the mark of the thing that would be there**, instead of a
paragraph of grey text against a blank area.

## What was tried and removed

A coloured stripe down the edge of every card with a state, borrowed from the way
the console marks log levels in its gutter.

It went in and came out. The lamp beside a server's name already carries that — it
has the state's colour, and it breathes while the server runs — so the stripe
restated it in a weaker form, and took space from a name that already truncates.
The console rail also works for a reason the copy would have destroyed: it stays
dark on almost every line, so you see the pattern before you read a word. Putting
one on everything would have given four stopped servers four stripes carrying
nothing, and left the one that mattered competing with them.

A lit edge now appears only where something is actually wrong — a scheduled task
Windows has never heard of — which is the rule the console was already following.

Nothing in this release changes behaviour. It is all appearance.
