---
name: my-move
description: List everything that is waiting on Dane, the operator, across every project the loop runs (Spirality, StarCaster, WaveCenter): tickets in "Needs your input" or "Ready to launch", pull requests waiting for his merge word, and anything only he can do (a real secret value, a billing screen, a browser login, a decision that is genuinely his). Read live, never from memory, oldest first, each with the one action it needs and a link. Use when the user runs /my-move or asks "what's waiting on me?", "what do I need to do?", "anything for me?" or "where am I needed?".
---

# What is waiting on Dane?

The user wants one list of every move that is theirs, across all projects,
so nothing sits in a queue because they didn't know it was there.

1. **Read every project's queue live.** Each project has its own tracker
   door; run it from that project's repository:
   - Spirality: `~/WebApps/spirality`. On the MacBook, prefix
     `TRACKER_API_URL=http://mac-mini.local:4180` and run outside the
     sandbox.
   - StarCaster: `~/WebApps/starcaster`. WaveCenter: `~/WebApps/wavecenter`.

   In each, run `npm run clickup -- queue --status "Needs your input"` and
   `--status "Ready to launch"`. Confirm each with
   `npm run clickup -- waiting --task <id>` (exit 3 means it really is
   waiting on him). A ticket the check says isn't waiting goes in a short
   "Looked like yours, isn't" note, not the main list. If a project can't
   be read, say so in the answer; never leave it out quietly.

2. **Find what the queues don't show.** Open pull requests in each project's
   GitHub repository that are green and waiting on his merge word
   (`gh pr list --repo <owner/name>`), and anything in this thread that only
   he can do: a real secret value, a billing screen, a browser login, a
   decision that is genuinely his.

3. **For each item, work out the one action.** Read the ticket's latest
   question card or comments and say exactly what he does: "Reply 'go'",
   "Reply 'merge' after trying <link>", "Choose A or B", "Paste the key into
   Doppler (project, config, name)". If the action has to happen on the Mini,
   say so and have him check the prompt shows `daneofearth@mac-mini`.

4. **Answer.** One line first: "Nothing is waiting on you" or "N things are
   waiting on you". Then group them by project, oldest first. For each:
   ticket id and exact title as a link, how long it has waited, and the
   action. Times are in Mountain time.
