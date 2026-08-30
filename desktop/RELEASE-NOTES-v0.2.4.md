A warning before you change who can join a world that already has players in it.

## Why this needs saying

Turning online mode on or off is not a setting change on a world people have played
on — it is an identity change.

Minecraft derives an **offline UUID from the player's name** and uses their real
Mojang UUID otherwise. Flipping this hands everybody a different UUID, and nothing
migrates: permissions, homes, inventories, and anything else a plugin stored
per-player stay attached to an identity nobody has any more. The same person joins as
a stranger.

That is easy to do by accident now that 0.2.3 put the control in the panel, and the
consequence only shows up later, as a support question.

## What it does

The two kinds of UUID are distinguishable after the fact — an offline one is
name-based (version 3), a real one is random (version 4) — so the world's
`playerdata` directory says exactly how many players are on each side.

Changing the control now shows, in place:

> This world already has data for 3 players, 2 of them under offline UUIDs. Changing
> this gives those players a different UUID, so anything stored against them —
> permissions, homes, inventories, plugin data — will not follow, and they will join
> as new players.

It appears when the control changes and disappears if you put it back, so the warning
tracks the decision rather than nagging. A world nobody has joined shows nothing at
all.
