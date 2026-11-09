## 2026-11-08 — WaveCenter and StarCaster cannot use the setup wizard: give it the steps for a project already on ClickUp (#128)

The setup wizard could only set up a brand-new project. WaveCenter and
StarCaster are not new: each already runs its own older copy of the loop,
with lanes on the Mini and its tickets in ClickUp. Moving one by hand meant
following a long runbook in the right order.

Now the wizard notices such a project (its folder on the Mini has its own
lane installer and no Spirality settings file) and asks one more question:
which ClickUp list its tickets are in. Then, before the setup pull request
is opened, it stops the old lanes (after checking none is half-way through a
pass), saves a full copy of the ClickUp list on the Mini, imports the
tickets into the tracker, and checks the switch is safe. Any of those
failing stops the run, says which, and the same command picks up there.
The setup pull request then lists which of the old loop's files it replaces
and which it leaves alone.

A brand-new project's run is exactly as before. This does not move
WaveCenter or StarCaster yet; those are their own tickets (SP-23, SP-25).
