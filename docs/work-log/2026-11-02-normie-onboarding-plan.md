## 2026-11-02 — Normie is not set up on Spirality yet: plan its onboarding as tickets (#68)

Dane said he was ready to bring Normie onto Spirality. Last pass wrote the
general checklist of what any product needs; this one walks that checklist
for Normie, item by item, looking at what Normie really has today: its code
on GitHub, the tracker, Doppler, and its copy on the Mini.

The short answer: Normie has its code and a CI check, but nothing that lets
the loops work on it yet. No settings file, no loop instructions, no place in
the tracker, no secret store, and its `main` branch is not protected. Its CI
is also failing on the latest dependency updates.

The plan is now written down in `docs/onboarding/NORMIE.md`, in the order
it has to happen, with a ticket for every missing piece. Five are filed in
Spirality's own queue: four fixes so a second product can run beside
Spirality without taking over its sign-ins, keys, logs or locks, and one to
set up Normie's tracker project and secret store. That last one files the
six tickets that change Normie's own code, once Normie has a queue of its
own. Nothing gets built until Dane says "go" on each one.
