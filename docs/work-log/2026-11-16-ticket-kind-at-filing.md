## 2026-11-16 — Set a ticket's kind and who started it when the loop files it (#287)

The day before, every ticket got three new answers: its kind (Feature, Fix,
Operational, Documentation), who started it (Dane, a client, or an agent
session) and how it ended. But nothing filled them in, so every new ticket
still arrived blank, and a productivity report would have had to guess.

Now the tracker fills in who started a ticket the moment it is filed, from
who filed it: a loop is an agent session, Dane is Dane, and anyone else he
has invited is a client, whose ticket is a Fix (a bug report) unless they say
otherwise. The tickets the loop files for itself, like "Resolve the merge
conflict on PR #N", the bus's Team chat and a new project's setup ticket,
are marked Operational, so they no longer count beside real features. The
intake loop now proposes a kind on every spec it hands Dane and says it on
the card; his "go" keeps it, and if he names a different kind the build loop
changes it before building. Copying a ticket into another project keeps both
answers.
