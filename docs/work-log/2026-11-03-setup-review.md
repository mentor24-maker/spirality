## 2026-11-03 — Streamline project setup process (#83)

Dane asked for a look back at how Normie came onto Spirality, every hold-up
in it, and a design for a setup wizard so the next product, PressPlay, takes
minutes instead of days. That is now one page,
`docs/onboarding/SETUP_REVIEW.md`. Nothing is built yet.

The look back, from the tickets' own comments and the merged pull requests:
about 50 hours and 15 tickets from Dane's "go ahead" to Normie's last merge,
and Normie's loops still do not run, because installing them was planned as
the very last step. Most of those hours were waiting, not work: overnight for
Dane's "go", in line behind other tickets in Spirality's single build lane,
and for someone to start Normie's sessions by hand. Four times Dane typed
"go" or "merge" twice because nothing was there to act on the first.

The wizard design asks every question once, up front, then does the steps
in a better order: Normie's loops would have gone in as soon as Normie had a
place in the tracker, not at the end. It stops for Dane only for his real
hand-offs (the secret store, a browser page, a decision), and checks every
step stuck before moving on.

PressPlay's repository turned out to be private, and GitHub will not
protect its `main` branch on the current plan. Since Spirality's repository
is public, the page says only that; the details of PressPlay's code are on
the ticket in the tracker. The page ends with nine questions for Dane.
