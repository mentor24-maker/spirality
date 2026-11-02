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
