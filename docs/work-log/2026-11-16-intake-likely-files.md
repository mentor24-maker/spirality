## 2026-11-16 — Have intake name the files each ticket will change and chain tickets that share one (#278)

Two tickets that changed the same file kept being built at the same time, and
then clashed when the second one tried to merge. It happened because tickets
were only ever told to wait for "the ticket this one builds on", never for
"the ticket that changes the same file", so SP-308 and SP-309, and later
SP-320 to SP-325, were all built side by side.

Now every ticket the loops write names the files it will likely change, on
one fixed line (`Likely files: ...`). Before filing a ticket, the loop that
writes specs looks at the open tickets' lines, and if the new one shares a
file with any of them, it waits on the newest such ticket. Tickets that share
a file therefore line up one after another, and the build lane picks some
unrelated ticket to build in the meantime, so no time is lost.

This change is the rule only, written in the loop contract and in the two
skills that file tickets. A later ticket (SP-351) adds the check that holds
a ticket back automatically.
