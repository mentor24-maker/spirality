## 2026-11-09 — Pipeline Status block (#143)

Dane had to ask a session to read the Mini's logs to find out when the loops would run next. Now the Tasks page tells him itself. A small box between the search field and the Board/List switch reads, for example, "Relay 7:03 PM · Build running · Review 7:10 PM · Intake 7:19 PM", and it reads again once a minute.

The times come from the same log files the installer's `--status` check reads. The tracker reads only the last part of each log, because the logs grow forever. It sends the page times and yes/no flags only, never any log text. A stage that hasn't run yet shows a dash. If the tracker can't answer, the box says "Pipeline Status unavailable" and the rest of the page works as before.

How often each loop wakes (30 minutes for build, review and intake, 10 for the relay) used to be written only in the installer. Now it lives in one small file that both the installer and the page read, so the page can't show a different schedule from the one the Mini runs.

This is the first of two slices. The second, SP-173, makes the box open a popup with more detail.
