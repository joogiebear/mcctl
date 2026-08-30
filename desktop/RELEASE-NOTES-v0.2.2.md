Follow-up to 0.2.1, fixing how the app is installed and how it remembers where your
servers live.

## Installs for you, not for the machine

The installer no longer offers "install for all users". Choosing it elevated, which
put the program in `C:\Program Files` and ran the first launch with an
administrator's environment — so the folder chosen in the setup wizard could be
written somewhere your own account never reads back.

mcctl keeps its data per-user regardless, so a machine-wide install bought nothing
and cost a UAC prompt. It now installs to `%LOCALAPPDATA%\Programs\mcctl` with no
elevation and no question.

## The setup wizard checks that it remembered

The data folder you pick is the only thing that tells mcctl where to look, and the
app resolves it once at startup. If that write did not land, the relaunched app fell
back to the default location and showed the wizard again — while any servers created
in between sat in a folder it no longer looked at. Nothing was lost, but nothing said
so either.

The wizard now reads the setting back before restarting, and refuses with an
explanation if it did not stick.

## Upgrading from 0.2.0 or 0.2.1

If you installed either of those for all users, uninstall first — this build installs
somewhere else and you would otherwise end up with two entries. Your servers are not
touched by uninstalling; they live in the data folder you chose, and the wizard will
ask for it again.
