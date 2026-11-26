## 2026-11-25 — Remove All Projects from the Tasks Board and List: it draws every ticket and freezes the page (SP-404)

Three days after All Projects arrived on Board and List (#334), the tracker
page stopped answering clicks in Dane's browser and Chrome offered "Page
unresponsive". A hand-run session traced it on a copy of the real store:
picked once, All Projects is remembered, so every click on Tasks drew all
1,596 tickets of every project, about 175,000 page elements from a 750 KB
answer. The page reads itself again every minute and draws everything again
when anything changed, which on a busy queue is nearly every minute; each
redraw froze Chrome for over a second. Switching the picker back to one
project cured it, and Dane's word was to take it out: "It's not worth the
effort."

Board and List show one project again. `/board` and `/list` with no project
after them open the remembered project, and a browser that still remembers
All Projects opens the first one. The every-project read on the tracker, each
row's project name, the Add Task box's Project chooser and the Topic picker's
project hand-off went with it.

The Console and Reporting keep All Projects: they draw work in flight and
counts (about 500 and 4,100 page elements with every project), not every
ticket, and the Console had it long before #334.
