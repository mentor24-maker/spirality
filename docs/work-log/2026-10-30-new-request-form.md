## 2026-10-30 — Dane cannot file work from the tracker page: add a New request form that files into a new Requested status (#36)

Asking for new work used to mean opening Claude Code. The tracker page now
has a **New request** link in its header: pick the project, write a title
and a description, press File request, and the ticket exists. It lands in
a new status, **Requested**, the first column on the board. No loop builds
from it, because a request is Dane's own words before anyone has turned
them into a buildable plan; a spec pass (the next ticket) will do that and
hand the plan back for his approval. Nothing he types is lost: a refused
submit says why and keeps the text, and so does being signed out. The
status exists only in the tracker; the ClickUp lists are unchanged.
