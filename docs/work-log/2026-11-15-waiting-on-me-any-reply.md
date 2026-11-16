## 2026-11-15 — Update 'Waiting on me' lists for all users as soon as someone responds (#252)

PP-8 was on both Dane's and Rich's Waiting on You lists. Rich answered it,
and it went off his list but stayed on Dane's, and the loop did nothing with
his answer. The list was not slow: the rule only counted Dane's own reply as
the answer.

Dane chose option A: an answer from anyone on the project counts. Now, when
a teammate replies to a question waiting in Needs your input, the ticket
leaves everyone's list and the relay sends it on to be built, just as if
Dane had answered. Merging is still Dane's alone, so a ticket waiting for his
merge word stays on his list whatever a teammate says. A comment whose
author can't be identified as a person is never counted as an answer.

Checked against PP-8's real history: the old code kept it on Dane's list;
the new code takes it off both. The list still refreshes once a minute and
whenever the tab comes back into view; refreshing at once was left for Dane
to decide.
