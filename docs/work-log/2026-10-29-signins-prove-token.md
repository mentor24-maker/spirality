## 2026-10-29 — The sign-in setup checks it is on the right machine before touching Doppler (#32)

The command that gives each loop its tracker sign-in keeps those sign-ins in
Doppler, which every machine shares, but checks them against the tracker's
database, which only the Mini has. Run on the laptop by mistake, it quietly
made an empty database, issued a sign-in that only that empty database knew,
and saved it in Doppler, where the real tracker then rejected it. Now it
refuses when there is no database, and it tries every new sign-in on the real
tracker before saving it. One the tracker rejects is cancelled straight away
and never reaches Doppler, and the message names the machine to use instead.
It finds "the real tracker" from the address in the project's settings file,
so a test tracker running on a laptop can never stand in for it. When the
sign-ins already in Doppler work at the tracker but not in the database in
front of it, it says this is the wrong database and to keep them, instead of
telling Dane to delete five good secrets. A tracker that is simply down is
reported as down, not as the wrong machine. The `check` step now asks the
real tracker too, so it can no longer report a wrong sign-in as fine.
