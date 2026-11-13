## 2026-11-13 — Pause and resume the pipeline, whole or per lane, from the Settings page (#212)

The Settings page has had pause switches since SP-224, but nothing on the Mini
looked at them. Now every lane checks them before each pass. If the whole
pipeline or that lane is paused, it writes one line in its log saying who
paused it and when (Mountain time), starts no Claude session, and sleeps until
its next wake. Switch the pause off and the next wake runs as normal.

A pause never stops work in the middle. The lanes check only between passes,
so a build already under way finishes and hands its ticket on, and nothing is
left stuck in Building. While that happens, the Settings page says "Draining:
N ticket(s) still finishing" and lists them, then "Paused: nothing in flight"
once they are done. The Pipeline Status pod on the Tasks page shows a paused
lane as "Paused" instead of a time it will never keep.

If a lane can't read the settings (the tracker is down, say), it treats
itself as paused and its log says exactly that. An idle Mini with a clear
reason is safer than lanes working without knowing whether Dane has stopped
them.
