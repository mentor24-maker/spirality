## 2026-11-02 — Normie's loops would take over Spirality's tracker sign-ins and stop Spirality's loops: give each product its own (#70)

Every loop signs in to the tracker on the Mini with its own key. The tool
that hands out those keys found each loop's sign-in by its name alone
("loop-build", "relay", ...), so setting Normie up would have given
Spirality's loop sign-ins new keys, and Spirality's loops would have
stopped working without anyone noticing.

Now each product gets its own. Spirality, which runs the tracker, keeps the
sign-ins it has. Any other product's loops get sign-ins named for that
product ("normie loop-build"), with their keys in that product's own
Doppler project, and it never touches Dane's own sign-in. The tool also
refuses to run against the wrong product's Doppler keys, and refuses to
re-key a sign-in that may belong to another product. The onboarding
checklist records the decision. Nothing was run for Normie yet; that is its
own setup ticket.

Review found a hole in that last refusal: if Dane made Normie's project on
the tracker page first, a wrongly copied settings file would have slipped
past it and re-keyed all six of Spirality's sign-ins, his own included.
The check now asks something that does not depend on which projects exist:
does this run's Doppler hold Dane's own working sign-in? Only Spirality's
does, so only Spirality may re-key the plain-named sign-ins once another
product is on the tracker. Normie's own sign-ins are never refused, so
retrying after a failed key write just works.
