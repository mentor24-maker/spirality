## 2026-11-17 — Give the tracker's title and next-task suggestions the lanes' long-lived Claude sign-in (#319)

The tracker page asks Claude for two things: five title ideas when you add a
task, and a list of suggested next tasks. Both run Claude on the Mini, and
both were still using the Mini's browser sign-in, which runs out between
November 22 and 25. The loops already got a sign-in that lasts about a year
(SP-385); this gives the same one to those two features, so they keep working
after the 22nd.

When the tracker starts, it reads that sign-in from Doppler, the secret store,
and writes one line in its log saying it did (never the sign-in itself). Only
the two Claude runs get it. If it isn't there, they work the way they always
have. Anything Claude prints back is checked, and any copy of the sign-in is
replaced with `[token]`, so it can't end up in a log or on the page. A sign-in
stored after the tracker started takes effect the next time it restarts.
