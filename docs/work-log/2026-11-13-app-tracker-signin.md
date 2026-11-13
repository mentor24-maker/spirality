## 2026-11-13 — Give each project's live website its own tracker sign-in, kept in Doppler (#206)

StarCaster's live website can now turn a client's bug report into a ticket and
post AI-spending alarms to its bus, but only if it can sign in to the tracker.
Until now the sign-in tool only made sign-ins for Dane, the loops and hand-run
sessions, so the website had nothing to use; borrowing the hand-run one would
have made every website ticket look like a hand-run session wrote it.

Every project now has one more sign-in, called `app` (`starcaster app` for
StarCaster), stored in Doppler as `TRACKER_TOKEN_APP`. The same command that
makes the loops' sign-ins makes it, proves it works, stores it and reads it
back; running it again leaves a working one alone. The test files a ticket and
posts a bus comment with it through the real server.

Still to do after merge: run that command for StarCaster on the Mini (a
Doppler write, so Dane's or a hand-run session's step), then Dane pastes the
token into Vercel (SC-799).
