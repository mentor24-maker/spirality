## 2026-11-10 — SP-199, slice 1 of 3: groundwork for StarCaster's auto-merge lanes

StarCaster merges some pull requests without Dane's word: tests and documents
(Lane A) and its own scripts (Lane B), after an hour's notice on the ticket.
Spirality's relay cannot do that yet, so StarCaster cannot move onto the
tracker without losing it. Dane chose to build it in three pull requests from
a hand-run session. This is the first, and nothing merges differently after it.

- **Two pieces moved from StarCaster with their tests:** the merge window
  (only one pull request at a time may move main, so they stop resetting each
  other's checks) and the ledger file (the record the caps and the stop switch
  live in, which is never written over when it cannot be read).
- **The protected-file list now comes from each project's settings.** It used
  to name StarCaster's own files inside shared code. Now the code holds only
  what every project shares, and each project lists its own in
  `governancePaths`. StarCaster's list is written down for its move. Checked
  over all 4,938 files on StarCaster's main: nothing it protects today loses
  protection.
- **Three real gaps closed.** A lane would have carried Spirality's relay
  (`scripts/clickup.mjs`, which runs merges), its tracker doors, and the
  engines behind the secret-key and wording checks. StarCaster's guard test
  came across and found the last two on its first run. It now fails the build
  if a lane could ever carry a file that merges, or one the merge step uses.

Next: SP-202, the lane up to a "would merge" note; then SP-203, the real merge.
