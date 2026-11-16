## 2026-11-14 — Make the setup wizard give every project the pipeline watchdogs (#245)

This week the six watchdogs that keep an eye on the pipeline came across from
StarCaster into Spirality: the heartbeat (has a lane stopped running?), stale
ready and stale answer (has a ticket been left waiting?), throughput (is the
queue getting shorter?), checkout currency (is the Mini running the latest
code?) and the failed-pass report. Until now only Spirality ran them, so if a
lane died in WaveCenter, Normie or PressPlay, nothing said so.

The setup wizard now copies them into every project it sets up, along with
the pieces they need and their commands, so a project's relay starts them on
every wake and they post what they find to that project's bus. The wizard's
first look also says where they will post, and says plainly when a project
has no bus and they would have nowhere to post.

Tests check that every watchdog file is on the wizard's list and arrives
unchanged, or with only the one change it needs (where it finds its modules
inside a project), and that every file the wizard copies can find what it
loads.

One correction to the plan: rerunning the whole wizard does not bring the
watchdogs to a project already set up, because it skips the copy once a setup
is merged. Running the copy step on its own does, opening one pull request in
that project for Dane to approve. The onboarding guide now says so.
