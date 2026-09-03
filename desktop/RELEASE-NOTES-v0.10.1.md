Call a server anything

## Names

- **The name field takes anything**, up to 48 characters - "Survival (Season 3)" included. It
  used to insist on letters, digits, dash and underscore, because the name is also the folder,
  the argument to every command and the scheduled-task name. Those still get a safe name; it is
  derived from what you type and shown under the field as you type it: `Survival-Season-3`, or
  `Survival-Season-3-2` if that one is taken.
- The name you gave shows on the card, in the header and in the edit dialog under Manage, where
  it can be changed or cleared. When it differs from the folder name, the folder name sits in
  small type beside the header so the console and commands still make sense.
- Existing servers are untouched; one with no display name shows its name as before.
- From a terminal, `mcctl set <name> label="…"` sets it and `label=off` clears it, and
  `mcctl status` reports it.

## Feedback

- The Feedback sheet has a door each for **A question** and **An idea**, opening a new post
  straight in the right Discussions category instead of on the index. The README and
  CONTRIBUTING say where each kind of thing goes.

## Also

- A dialog that opens the moment another closes - Manage, then Edit - can no longer be shut by
  the first one's late close event.
- The repository has a Sponsor button, and `main` merges on green CI.
