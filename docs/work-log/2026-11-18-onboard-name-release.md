## 2026-11-18 — Name a new project's Spirality release during npm run onboard and wake its relay before judging it (#322)

A project set up without its own copy of the loop runs only the version of
Spirality (a "release") picked for it. When Cassidy was set up, nobody had
picked one, so its relay had nothing to run and the setup failed at its
lanes step, two steps after it could have spotted the problem. Dane had to
cut a release, name it for Cassidy, and start a fresh relay pass by hand.

Now the setup handles this itself. Its first read-only look says whether
the project has a release, whether the setup will pick one, or whether
none exists yet and someone needs to make one (`npm run release -- cut`).
Just before the lanes are started, the setup picks the newest release for
a project that has none and checks the pick was saved. If no release has
ever been made, it stops with one plain sentence saying how to make one,
not with a confusing relay failure. On a rerun after a relay pass that
found no release, it starts a fresh relay pass and judges that one rather
than the old failure. A project that already has a release keeps it.
