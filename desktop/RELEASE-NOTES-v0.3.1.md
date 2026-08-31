The Performance tab now tells "never measured" apart from "not in this range".

A server stopped an hour ago has nothing in the last five minutes and plenty on
disk. The tab said **Nothing recorded** — which is untrue about your own data, and
sends you looking for a bug rather than at a longer range.

It now says how long ago the server last ran, how many readings are kept, and names
the shortest range that would show them:

> Nothing in this range. This server last ran 53m ago, and 82 readings are kept — try 1h.

When there genuinely is no history it still says so. The difference matters most
right after a crash, which is exactly when "what was it doing before it stopped" is
the question being asked, and the answer was being hidden behind a default window.

Nothing else in the app changed. The other two commits since v0.3.0 are the README
and the release tooling, neither of which reaches the binary.
