Releases are signed from now on.

## What changes for you

The installer now carries a verified publisher identity, so Windows names the
publisher instead of saying "Unknown publisher".

**SmartScreen will still warn.** It is a reputation system rather than a signature
check, and reputation builds through real installs of files from the same publisher.
A brand new publisher identity has none yet, so the blue box still appears —
**More info → Run anyway**, same as before. What is different is that every release
from here feeds one identity, rather than each unsigned installer starting from
nothing. Extended Validation certificates used to grant reputation automatically;
Microsoft removed that in 2024, so there is no way to skip the queue.

## Under the hood

Signing goes through Azure Artifact Signing. The certificates it issues live about
three days and rotate automatically, so every signature is timestamped — without one,
everything already shipped would stop validating within the week rather than staying
valid for the moment it was signed in.

The build refuses to produce a release whose executable is configured to be signed and
is not, or whose signature carries no timestamp. There is no CI on this project, so a
signing step that quietly stopped working would otherwise ship.

Nothing else changed. Same panel, same servers, same data.
