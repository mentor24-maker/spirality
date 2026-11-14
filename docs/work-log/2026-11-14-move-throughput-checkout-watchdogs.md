## 2026-11-14 — Move the throughput, failed-pass and checkout watchdogs into Spirality (#241)

Three of the small checks StarCaster built to watch its own loop now live in
Spirality, so every project can have them.

The **throughput** check asks the question a "still running" check cannot:
is the queue actually getting shorter? A loop can run every half hour, finish
cleanly every time, and ship nothing, and its log reads as health. This one
counts what reached Live each day and how much work sat open, and says on the
bus when nothing has shipped for a day while work waited.

The **checkout** check asks whether the Mini is really running the latest
code. In StarCaster a single file left in the wrong place once stopped the
machine updating itself for hours, and only a log nobody reads said so. Now
the bus hears it, with the names of the files in the way. In Spirality the
relay already does the updating, so this check only reads and reports; it
never updates anything itself.

The **failed pass** report means a lane that keeps failing (a sign-in that
expired, a service that is down) is said on the bus, not only in its log.

Each says a finding at most once every six hours, and none of them can stop a
lane or change what the relay decides. They post to Spirality's bus project,
which still has to be created on the tracker (the step #237 left for Dane);
until then their posts fail and say so in the log, as the relay's do.

After review sent it back, five things were put right. The throughput check
no longer counts tickets waiting on Dane (or his unspecced requests) as work
the loops are sitting on, so a quiet day while he is away is not texted to
him as a stall; it says how many wait on him, apart. Every time it shows is
Mountain time, and its days are Mountain days, so an evening's work lands on
that evening. It no longer tells the reader to run a heartbeat command this
project does not have yet. A new project's empty queue reads as quiet, not as
"could not take a reading". And the checkout check no longer reaches out to
GitHub itself, so it can never collide with the relay's own update.
