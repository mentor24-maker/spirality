## 2026-11-16 — Add Topic filter to search bar on Tasks (#276)

Searching the tracker could already narrow by project, status, priority and
person, but not by topic, the named groups Dane files tickets under (such as
"Board" or "Notifications"). Now it can.

On the Tasks page a Topic picker sits between the Project picker and the
Search box. It lists only the topics of the project in view, because each
topic belongs to one project. Pick one, search, and only tickets carrying
that topic come back. The Search page has the same Topic filter next to
Project. While no project is chosen it is greyed out with "Pick a project
first", and changing project clears it, so a search can never mix one
project's topic with another project's tickets. A link that tries anyway
gets a plain sentence saying why, not an empty list. Searches that choose
no topic behave exactly as before.
