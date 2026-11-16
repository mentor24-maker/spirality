## 2026-11-16 — File Dane's decisions on the seven pipeline watchdogs that have no ticket (#269)

Seven of StarCaster's loop watchdogs (the small scheduled checks that say
when something has gone wrong) had no plan for Spirality. Each one was waiting
on a call from Dane, but nothing had written those calls down. `docs/WATCHDOGS.md`
now has a "Seven questions" section with one plain question per watchdog, a
recommended answer and the reason for it. Every recommendation was checked
against Spirality's own code, not taken from the earlier notes.

The short version: five need nothing new. Two are worth part of a move:
a read-only check for tickets left behind when a pull request is merged or
closed straight on GitHub, and a copy of the tracker's nightly backup kept off
the Mini, so a dead disk does not take every project's tickets with it.
The next ticket, SP-330, sends Dane these questions so he can answer them all
at once.
