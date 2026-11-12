## 2026-11-12 — The pipeline's timing and limits are fixed in code: give Dane controls on the Settings page to experiment with (#197)

Until now, how often each loop wakes, how many tickets it may have in flight
and which model it runs on were numbers written into the code. Changing one
meant a pull request. Dane wants to experiment with them.

This first slice gives the tracker a place to keep those numbers for each
project, and puts them on the Settings page under a new **Pipeline Controls**
heading: wake times, pause and resume, the work-in-progress cap and the model
for each lane. Each starts at what the loop does today and is marked
"default" until he changes it. Only he (the project's operator) can change
them; anyone else, and any loop, is turned away. Every change is written to a
log on the same page (who, when in Mountain time, old value, new value), so
the time-in-status report can later compare before and after. The page only
says "Saved" when the tracker reads back the value he sent.

The loops get one command to read them, `npm run clickup -- settings`. They
do not act on them yet: the next four tickets (SP-236 to SP-239) each wire
one control into the loops, and the page says so under each group.
