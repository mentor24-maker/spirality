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

Review sent it back once, because the list and the relay could still
disagree about a teammate's comment, and a ticket could vanish from Dane's
list while nothing moved it. Two cases are now closed. A teammate's comment
counts only when it answers one of the loop's question cards: a ticket
parked with no question stays on Dane's list. And once an answer has been
acted on and someone parks the ticket back for Dane by hand, a teammate's
"any update?" no longer sends it off again; only Dane's own word does. The
"your answer has sat" alarm follows the same rule, so it no longer fires
about a teammate's passing comment. Replaying PP-8 from a copy of the live
tracker still takes it off both lists.

A second send-back found two more corners. When a teammate's answer had
already been acted on and the ticket was parked again, an older comment of
Dane's (say "let me think", written before the answer) could still be read
as a fresh answer and send the ticket off. Now only something Dane writes
after the answer that was acted on counts. And the step that posts a new
question to Dane now refuses when a teammate has just answered the last
one, the same way it already refused when Dane had, so a fresh question can
never bury someone's answer.
