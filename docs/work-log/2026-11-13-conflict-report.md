## 2026-11-13 — Nobody can tell whether faster wake times cause more merge conflicts: record each conflict with the settings in force and report conflicts per merged pull request (#225)

Dane shortened the loop's wake times today and asked to see what that costs in merge conflicts, rather than guess. A merge conflict is when two pieces of work changed the same lines, so the second one cannot be merged until somebody settles which version wins.

The Reporting page now has a Merge Conflicts section. It counts every conflict under the settings in force when it happened, and every merge the same way, then shows conflicts per merged pull request for each set of settings. That is the fair comparison: faster timers mean more merges, so a raw count of conflicts would rise even if nothing got worse. Under the old timers, Spirality had 63 conflicts over 212 merges (about 0.30 per merge); the new timers start at 0 over 5.

Below that, every conflict is listed with a link to its ticket: which merge caused it, what stage the ticket was in, how long its pull request had been open, how many were open at the same time, the files that clashed, and whether the two tickets came from one request split into pieces. The files that clash most are listed too.

Nothing new is recorded to make this work. The loops already leave a note on a ticket each time a conflict shows up, and the tracker already keeps every settings change, so the report is worked out from those each time the page opens, and it covers the whole history.
