The window opens where you left it.

## What changed

Every launch used to open at 1280x820 in the middle of the screen, whatever you had
done to the window last time. Size, position and maximised state are now remembered.

Saved on a short delay rather than on every event — dragging a window emits a move per
frame and none of them are the answer, only the one where you stopped. Un-maximising
restores the size the window had before it was maximised, not the size of the screen,
and a window left maximised comes back maximised without first appearing at its
restored size and jumping.

## The part that matters

The classic way to lose a window is to restore it onto a monitor that is no longer
attached: the app launches, reports itself running, and paints at x=-1920 where you
will never find it.

A saved position is honoured only when a usable part of the window would land inside
some display's work area — enough of the title bar to grab, not a pixel of contact.
Otherwise the position is dropped and the window is centred. The size is kept either
way.

That decision depends on which monitors are plugged in, which is the one thing a test
cannot arrange, so the logic takes the display list as an argument and the tests pass
it fictional ones — including a window last seen on a second monitor that has since
been unplugged.

These are the first tests in the repository. `npm test`, from `desktop/`.
