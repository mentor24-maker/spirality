## 2026-11-06 — The tracker keeps running old code after a merge: restart it when a pull changes its files (#118)

When a change to the tracker was merged, the Mini downloaded the new files but
the tracker server kept running the old program until somebody restarted it by
hand. On November 6 it had been running for two days and was missing about 16
merged changes, including roles, project members and attachments, so what Dane
saw on the tracker page did not match what had been built.

Now, every time one of the loops pulls the latest main, it checks whether the
pull changed anything in the tracker's folder. If it did, it restarts the
tracker, waits for it to answer again, and writes one line in its log saying it
restarted, or a line in capitals saying the restart did not work. A pull that
does not touch the tracker restarts nothing, and a project that runs no tracker
is never affected. The restart costs a few seconds of downtime.
