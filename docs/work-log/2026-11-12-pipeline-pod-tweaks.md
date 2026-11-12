## 2026-11-12 — Tweaks to Pipeline Stages pod (#195)

The small Pipeline Stages box on the Tasks page, the one that shows when Relay,
Build, Review and Intake run next, got the seven look changes Dane asked for.
It is now light blue (#cceeff) with a dark blue border and some room around
it. Its heading is half again as big, and a running stage is a brighter green.
Times read "10:45 am" in lowercase. The useful new part: when a stage is less
than three minutes from running, or already due, its name and time turn gold,
so it's easy to see what is about to happen. The box already redraws itself
every minute, so the gold appears without reloading the page. The dialog that
opens when you click the box looks the same as before.
