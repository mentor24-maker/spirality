## 2026-11-14 — Add Approve and Reject buttons to a held bug report and drop its Reply box (#248)

When a visitor on a client's website sends a bug report, it lands in the tracker held for Dane, waiting for his say-so before any loop touches it. Saying yes used to mean opening Details, then the Change panel, then picking a status from a dropdown, and the Reply box on those tickets did nothing at all, because no loop reads a reply there.

Now a held bug report has two buttons at the top: **Approve**, which sends it to the intake lane to be written up as a proper spec, and **Reject**, which closes it as "won't do" with a note saying nothing was built. Each asks once before it acts, checks afterwards that the change really stuck, and says plainly which part failed if one did. The useless Reply box is gone from these tickets, replaced by a short line saying why. Every other ticket looks exactly as it did.
