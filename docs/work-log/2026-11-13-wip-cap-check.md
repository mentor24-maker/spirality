## 2026-11-13 — Stop loop-build claiming new work at the cap set on the Settings page (#217)

The Settings page has had a "work-in-progress cap" box since SP-224, but nothing obeyed it: the build lane kept starting new tickets however many were already open. Now, right before the build lane picks up a ticket, it counts what is already in flight. That means tickets being built, and tickets with an open pull request waiting for review. If that count has reached the cap Dane set, the lane starts nothing and says so in one line, for example `full: 5 of 5 in flight (SP-1, SP-2, ...)`.

This matters because every merge makes every other open pull request out of date, and each one then needs catching up. Past a point, more open work ships slower. The cap lets Dane try different numbers and watch the effect.

If GitHub or the tracker does not answer, the lane carries on without the cap and says so, rather than stopping all work over a short outage. The Settings page now shows how many tickets are in flight beside the cap, so a stalled build lane is easy to spot, and it no longer says the cap is "not used yet".
