## 2026-11-06 — Nobody is tied to a project yet: record which users belong to which project and show it on each project's page (#117)

The tracker had users and projects but nothing saying who belongs to which.
Now it keeps a membership list for every project, the way StarCaster does.
To begin with, everyone already in the tracker is a member of every project,
so nobody loses anything. A project's owner and operator are always on its
list, and so is whoever makes it.

Each project's details page shows its members. An admin can add someone
from a picker, or remove someone, and the page checks the list again before
saying the change worked. The owner and operator cannot be removed, and the
page says why. The Users page now shows which projects each person is on.

Nothing is hidden from anyone yet: this records who belongs where. The next
slice (SP-145) uses the list to decide what each person sees.
