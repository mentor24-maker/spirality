## 2026-11-17 — Add Project filter and Pipeline Stages bar to the Console on Tasks (#315)

The Console, the map of every ticket in flight, now has the same strip of
controls under its "Tasks" title that the Board and List views have, but
with only three things on it: a Project picker, the Pipeline Stages box and
the Features key.

The Project picker starts on "All Projects". Choosing one project hides
every other project's tickets from the whole page, so the counts on each
area and on the Features key always match what you can see. The choice
stays put through the Console's once-a-minute refresh, and it does not
change which project Board or List opens.

The Pipeline Stages box is the same one Board and List show, and clicking it
opens the Pipeline Status window. The Features key moved up from above the
map into the strip, where Board and List keep their other filters. As Dane
asked, none of those other filters (Topic, Search, Kind and the rest) came
across to the Console.
