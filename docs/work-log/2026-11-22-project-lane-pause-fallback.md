## 2026-11-22 — A project's own lanes never run because the tracker has no pause switch for them: give each one its own (#332)

WaveCenter has a lane of its own, the hand-off lane, besides the four every
project gets. Before each pass a lane asks the Settings page whether it has
been paused. The page only has switches for the four standard lanes, so the
hand-off lane's answer had no switch in it, and a missing switch is read as
"paused", the same safe answer the lanes give when the tracker cannot be
reached. So the hand-off lane has sat paused since November 14, and ten
WaveCenter tasks have been waiting on it.

Now a lane the project's settings file lists as its own follows the
whole-pipeline pause switch alone until it gets a switch of its own (the next
ticket, SP-401), and its log line says that is what it did. Pausing the whole
pipeline still stops it, and a tracker that cannot be read still pauses every
lane. Asked of the live tracker as the hand-off lane, this branch says
"running" where main says "paused".
