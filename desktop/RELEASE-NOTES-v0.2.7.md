Every release now says which commit built it.

The source repository is private and this one holds only binaries, so nothing
previously connected `mcctl-Setup-0.2.6.exe` to the code that produced it. Six months
from now, "what is actually in this build" had no answer beyond trusting the version
number — and a version number is a label someone typed.

The commit is recorded at **build** time rather than publish time, because those are
not the same moment: a release is uploaded as a draft and can sit while the branch
moves on. It appears in two places:

- at the bottom of these release notes
- in the app, under **Settings → About**, so a bug report can name the exact build
  rather than a version several builds could share

A build made from a tree with uncommitted changes says so, in both places. That is
the case worth flagging, because it is the one that cannot be reproduced from any
commit.

Releases are also published in two steps now — built and uploaded as a draft, then
made live only after the assets are confirmed present, complete, and described
correctly by the update feed. v0.2.6 went out live with a failed installer upload and
no update feed for a few minutes; this makes that impossible rather than unlikely.
