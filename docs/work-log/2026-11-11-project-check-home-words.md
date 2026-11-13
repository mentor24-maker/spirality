## 2026-11-11 — The Add Task box keeps asking whether a Spirality task belongs to WaveCenter (SP-225)

Dane kept getting "Did you mean for that to be associated with project
WaveCenter?" when adding Spirality tasks, though he hadn't filed one for
WaveCenter in weeks.

**Why.** The check adds up, word by word, how many of each project's
tickets use what he typed, and asks when another project leads by 0.5.
WaveCenter is itself about scoring tasks, so "task" is in about 80% of its
tickets (38% of Spirality's), and "page", "data", "logo" lean its way too.
A request about the tracker's own Tasks page piled up those small leads and
crossed 0.5 on everyday words alone. Replaying the 149 requests Dane typed
(each ticket's `## Asked` block) against today's tickets: 35 would have
been asked, nearly every Tasks-page request among them.

**Fix.** A word the project being filed into already uses (more than 2% of
its tickets) is at home there and counts for no project; only words that
are strange here can point somewhere else. Project names count as before.
Same replay: 5 asked instead of 35 (four of them name another project
outright), and 117 of the 128 wrong-project filings the old rule caught are
still caught. `tracker/projectGuess.mjs`, rule 3.
