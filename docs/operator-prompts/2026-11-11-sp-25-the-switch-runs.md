## 2026-11-11 and 11-12: SP-25, the switch runs

1. > every sign-in is in order. Done

   Led to: StarCaster's five sign-ins (actors 31 to 35) checked, and the wizard's bus step made `starcaster-bus`.

2. > SP-235 is Live (PR #179 merged at 2:22 PM). Rerun the onboard step for SP-25.

3. > Run SP-25, StarCaster still runs on ClickUp: move it to the tracker, as a hand-run session. SP-235 is Live; rerun the onboard step.

   Led to: the second run stopped safely at the snapshot on a reply count (one comment had 26 replies and ClickUp pages them 25 at a time). Filed and built [SP-242](http://mac-mini.local:4180/t/SP-242) ([#181](https://github.com/mentor24-maker/spirality/pull/181)).

4. > SP-242 is Live; rerun the onboard step for SP-25.

   Led to: the stop, snapshot, import and switch check passed. Then the copy failed at StarCaster's commit (its pre-commit hook needed packages, and 53 of its old-loop tests failed).

5. > Restore old loops

   (his answer in the session, at about 7:40 PM on 11/11)

   Led to: StarCaster's old lanes reinstalled. Filed [SP-252](http://mac-mini.local:4180/t/SP-252) and [SP-253](http://mac-mini.local:4180/t/SP-253), and added both to SP-25's `Waits on:` line.

6. > Run SP-25, StarCaster still runs on ClickUp: move it to the tracker, as a hand-run session. SP-252 and SP-253 are Live; rerun the onboard step.

   Led to: the wizard ran through the lanes step (StarCaster setup PR [#1003](https://github.com/mentor24-maker/starcaster/pull/1003), setup ticket SC-790), and StarCaster's lanes now run from `spirality-setup`. StarCaster's review lane sent SC-790 back to Rework: the copy replaced its `.claude/settings.json` and dropped six hooks, and retired two test files of live code. Filed [SP-254](http://mac-mini.local:4180/t/SP-254) (this ticket) and added it to SP-25's `Waits on:` line.
