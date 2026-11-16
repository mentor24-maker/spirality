## 2026-11-13 — Run each lane on the model chosen on the Settings page (#218)

The Settings page has let Dane pick a Claude model for each lane (intake,
build, review) since SP-224, but nothing used the choice: every pass ran on
Claude's default. Now each lane's runner asks the tracker for its model just
before every pass and starts the session on it.

Picking "Claude's default" leaves the lane doing exactly what it always did.
If the tracker cannot be reached, or somehow answers a model that is not on
the page's list, the lane also falls back to the default and writes one line
in its log saying why, so a bad setting can never stop a lane or hand Claude
something nobody chose.

Each pass's opening line in the lane's log now names the model it ran on,
and the Settings page reads that line to show, beside each lane, what its
last pass actually used. Right after a change it says plainly that the next
pass will pick it up, so Dane can see when an experiment has really started.
