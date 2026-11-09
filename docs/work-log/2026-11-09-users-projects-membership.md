## 2026-11-09 — Dane cannot put a user on a project from the Users or Projects page: give both pages Add and Remove (#131)

Dane was signed in as an admin and wanted to put a person on a project. He looked on the Users page and on the Projects page, but neither had a way to do it. The only place was one level down, on each project's own page. Now both pages have it:

- On the **Users** page, each person's Projects cell has a Remove button next to each project and an "Add to Project…" picker.
- On the **Projects** page, a new Members column has a Remove button next to each member and an "Add Member…" picker.

A project's owner and operator are marked as such and can't be removed, the same as on the project's own page. After every change the page reads the list again. It only says the change worked when that read agrees, and if the tracker refuses, the page shows the reason. People who are not admins see the lists but no buttons. Nothing changed about who is allowed to change members.
