## 2026-11-13 — Let the Add Task box suggest titles, with a toggle to write my own (#229)

The Add Task box on the Tasks page no longer makes Dane think up a title
before he can file something. A toggle at the top picks how: **Suggest a
Title** shows only the Description box, and **Write My Own Title** shows the
Title box too, as before. Either way, pressing **Suggest Titles** asks the
tracker for five titles written from his description (the suggester built
in the previous slice) and shows them as a list to pick from; when he typed
his own title, it is the first choice. **Suggest Again** asks for a fresh
five. The title he picks is the one the ticket is filed under, and the
"Did you mean another project?" check still runs first.

If the suggester is down or answers nonsense, the box says so in one plain
line and shows the Title box, so he can still type a title and file. The
toggle remembers his choice in the browser, so the box opens the way he
left it.
