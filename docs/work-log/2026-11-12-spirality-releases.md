## 2026-11-12 — One Spirality change would reach every project at once: name a Spirality release for each project, Spirality's own lanes first (#204)

Once the loop code lives only in Spirality, every project runs the same
code. Without a safeguard, one bad change would hit all of them at the same
moment. Dane chose a staged rollout: Spirality's own lanes try each change
first, and every other project runs a fixed, named version until it is moved
on.

This is the first of four steps. Spirality now has **releases**: a release
is a snapshot of Spirality's main code, labelled `release-1`, `release-2` and
so on. `npm run release -- cut` makes the next one and checks it reached
GitHub. If nothing has changed since the last release, it refuses.

The tracker now records which release each project runs, with who chose it
and when. Three new commands work that record: `release list` shows every
project's release, `release name` sets one, and `release back` returns a
project to the one it ran before. Each change is read back. Spirality's own
project always runs the newest code, so it is never given a release.

Nothing runs from this record yet. The next steps show it on the Settings
page, run each project's lanes on its release, and move a project forward
after a quiet period.
