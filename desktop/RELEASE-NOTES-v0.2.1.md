A same-day fix for the first thing a new install does.

## What went wrong

Creating a server and pressing **Start** could fail with:

> MCCTL_Test did not start: the supervisor process never came up.

The cause was an unusable memory value reaching the registry. `*G` is what you get
typing `8G` with the shift key caught a keystroke early, and nothing checked it —
not the form, not the API. It went in, survived the jar download, and only became a
problem when the supervisor built `-Xmx*G` and threw.

At that point the supervisor died while its module was still loading, which meant it
wrote **nothing**: no log, no state, no stderr. All the app could say was that it
never came up.

## Fixed

- The memory field is checked as you type, and again by the API before anything is
  created. `4G`, `6144M` and `2.5G` are fine; `*G` is refused with a message that
  says what the field wants.
- A supervisor that fails during startup now records why, synchronously, and the app
  reports it immediately instead of waiting fifteen seconds to say nothing useful.
- A recorded failure no longer poisons the next attempt, so fixing the value and
  pressing Start again just works.

## If you already hit this

No reinstall needed to recover the server — open **Manage… → Rename, or change
memory and port**, set the memory to something like `4G`, and Start. Updating to
0.2.1 stops it happening again.
