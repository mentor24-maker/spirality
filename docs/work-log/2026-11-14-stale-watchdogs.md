## 2026-11-14 — Move the stale-ready and stale-answer watchdogs into Spirality (#240)

Two of StarCaster's watchdogs now watch every Spirality project's tickets.
The first notices a ticket stuck waiting to be merged. The second notices a
question the operator has answered when the ticket still has not moved.

Stale-ready doesn't just say "this ticket is stuck". It says whose turn it
is. A failing test or a merge step that has stopped is the machine's
problem, and saying so keeps the operator from being told they are the
blocker when they are not. Only a green, reviewed pull request with no merge
word is called theirs. Stale-answer exists because an answered question
that nothing acts on looks, from the operator's side, like it was handled.

The relay runs both on every wake. Each says a stuck ticket on the bus once,
then waits six hours before saying it again, and clears its reminder once
the ticket moves. A watchdog that breaks is logged by name and never stops
the relay. The code came across from StarCaster with its tests. It was
changed only to read tickets through Spirality's own door and to take every
name from the project's settings, so the setup wizard can give the same
watchdogs to WaveCenter and the others next (SP-269).

Review sent it back once, rightly: the first copy of stale-answer had
dropped StarCaster's "already handed back" check. When the relay moves an
answered ticket on, it leaves a short reply under the answer saying so, and
a ticket parked back in Needs your input on purpose after that is meant to
stay quiet. Without the check, the watchdog would have called that a broken
hand-back every six hours. Now, for an answer that is already late, it reads
that reply through a new read-only door command (`replies`), the same reply
the relay itself goes by, and stays quiet when it is there. If that read
fails, the alarm still goes out; it is never silenced on a guess.
