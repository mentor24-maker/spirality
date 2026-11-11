## 2026-11-10 — Let the relay merge a lane's pull request when its hour ends with no objection (#168)

StarCaster has two "auto-merge lanes": a small, safe pull request (only tests and
documents, or only the pipeline's own scripts) announces itself on its ticket
and merges an hour later unless Dane says something. Spirality's relay learned
the first half of that yesterday (SP-202) but stopped at a note saying "this is
where I would merge". This change lets it actually merge.

It merges only through the same checks Dane's own "merge" goes through: a
review pass on file, checks green, branch up to date, no conflict. The merge
itself uses the same commands too. Only one pull request at a time may move
main (the "merge window"), so two merges can't keep resetting each other's
checks. Every merge is written down for the hourly and daily limits and the
daily summary. If a merge ran but can't be confirmed, every lane switches
itself off and says so until Dane says "resume auto-merging".

Spirality and WaveCenter have no lanes switched on, so nothing changes for
them. This is the switch StarCaster needs before it can move its own
auto-merging onto the tracker (SP-25).
