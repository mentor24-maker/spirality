## 2026-11-09 — Extra project lanes cannot sign in to the tracker: give them seats (#139)

Every loop lane signs in to the tracker with its own key, so the tracker
knows which lane made each move. Until now the list of lanes allowed a key
was fixed in Spirality's code: build, review, intake, the relay and a
session started by hand. WaveCenter wants a lane of its own, the hand-off
lane that files the tasks its members tick for the AI agents, and that lane
had no key to sign in with, so it was held back.

Now a project lists its own lanes in its settings file
(`"projectLanes": ["loop-handoff"]`). Each one listed gets a key of its own,
made and checked by the same sign-in command as the others, reported by
`npm run doctor`, and accepted when the lane works on the tracker. A lane
that is not listed is still turned away, and the message now says where to
list it. A lane cannot borrow a built-in lane's name, so two lanes never
share one key; such a name is refused the moment the settings file is read,
so one bad entry can never stop the built-in lanes from signing in (the
first review caught that it was refused too late, inside every lane's
sign-in). No WaveCenter names went into Spirality: each project says
its own. Next is WaveCenter's own ticket to install the hand-off lane.
