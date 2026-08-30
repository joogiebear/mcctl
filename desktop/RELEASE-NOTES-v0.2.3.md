New servers now require a Minecraft account by default, and the panel can edit the
settings people actually change.

## Online mode is the default

Servers created by mcctl used to start with `online-mode=false`. The reasoning was
that a scratch server is for testing, and offline lets you join as any name without
an account. The cost turned out to be higher than the convenience.

Offline mode gives players **name-derived UUIDs** instead of Mojang ones, so any
plugin that keys data by UUID behaves differently — some bugs will not reproduce, and
some appear that do not exist on a real server. Paper also prints a four-line
`**** SERVER IS RUNNING IN OFFLINE/INSECURE MODE!` banner near the top of every log,
and plugin authors routinely refuse a bug report carrying it.

A tool whose job is reproducing plugin bugs should not produce reports that get
thrown out on sight.

**Offline is still one toggle away** — for testing with several accounts, or with no
internet:

- the create form now asks who can join, and says what each choice costs
- `mcctl new <name> --offline`
- `mcctl props <name> online-mode=false`
- **Settings…** on any server in the panel

A server running in offline mode is badged in the panel, because it is a different
kind of server and its logs are treated differently.

**Existing servers are untouched.** The default applies only to newly created ones,
and adopting a folder still keeps whatever it already had.

## Settings, in the panel

The panel could not change a single server property. It can now edit the handful that
matter: who can join, message of the day, difficulty, default game mode, max players,
PvP, whitelist, view distance and spawn protection.

Values the server has not written yet show Minecraft's default rather than a blank
box, marked as such. Only fields you actually change are written, and nothing else in
`server.properties` — including its comments — is disturbed. Changes apply the next
time the server starts, which the dialog says rather than leaving you to wonder.

Everything else in the file stays where it is, for `mcctl props` or an editor.
