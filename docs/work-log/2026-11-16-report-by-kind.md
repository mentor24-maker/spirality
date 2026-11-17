## 2026-11-16 — Split the Reporting page by ticket kind and stop counting dropped and test tickets as finished (#293)

Every ticket now has a kind: a feature, a fix, keeping-things-running work (operational) or documentation. Until now the Reporting page counted them all the same. It also counted a dropped ticket, a duplicate or a test ticket as finished, because those close the same way real work does.

Now those three endings are never counted as finished: not on the Reporting page, not in the stage counts StarCaster's weekly report reads, and not in the watchdog that checks the queue is moving. A day when only dropped tickets closed no longer looks like progress. The page lists them on their own, under Closed Without Finishing.

The Reporting page also has a Kind picker that narrows every figure to one kind, plus three new tables:
- **By Kind**: finished and started counts for each kind.
- **Efficiency**: how many operational tickets it took per feature finished, and what share of ticket time went to operational work.
- **Who Started the Finished Tasks**: Dane, a client or an agent session.

With these, a week can read as "2 features, 1 operational", and you can see whether keeping-things-running work is growing or shrinking.
