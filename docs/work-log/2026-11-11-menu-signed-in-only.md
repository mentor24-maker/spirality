## 2026-11-11 — Main menu should only show to logged in users (#182)

The links across the top of the tracker page (Projects, Tasks, Reporting,
Users, Docs, Settings) used to show to anyone who opened the page, even on
the sign-in screen. Now they appear only once someone has signed in, and
disappear again on Sign Out, when a sign-in runs out, and on the Forgot
Password and Set Your Password screens. They also stay hidden during the
brief "Loading…" moment, so they never flash up before the page knows who
you are. The Spirality logo still shows for everyone.

This only changes what the page shows: the tracker already refused to hand
its data to anyone not signed in.
