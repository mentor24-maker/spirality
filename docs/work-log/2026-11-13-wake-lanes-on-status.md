## 2026-11-13 — Wake the next lane when a ticket enters its status (#209)

Yesterday's change (#191) gave each loop a way to be woken early. This one
makes the tracker actually use it. When a ticket lands in a status that a
loop handles, the tracker wakes that loop at once instead of leaving the
ticket to wait out the loop's 10- or 30-minute timer:

- a new request (Requested) wakes the intake loop;
- a ticket ready to build or sent back (Queued, Rework) wakes the build loop;
- a ticket ready to check (In review) wakes the review loop;
- Dane's comment on a ticket waiting for him (his "merge", "go" or answer)
  wakes the relay, which carries out his word.

Each loop still decides for itself whether a pass can start, so a loop that
is busy finishes its pass first and never runs twice at once. Only
Spirality's own tickets wake Spirality's loops. A loop never wakes itself,
so a loop that keeps handing the same ticket back cannot run non-stop. If a
wake fails, the move still happens and the tracker's log says so in one
line. The timers stay as the safety net.
