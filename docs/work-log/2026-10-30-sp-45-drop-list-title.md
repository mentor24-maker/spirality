## 2026-10-30 — The list page shows the project name twice: drop the big title above the toggle (#35)

The board and list pages used to show the project's name twice: once as a
big title, once in the project picker. While this fix waited for review,
another change replaced the picker with a plain "Change project" link, so
just deleting the title would have left the page not saying which project
you were looking at.

Dane chose the layout: the project's name now sits in the black header, just
left of "Signed in as Dane", and the big title on the board and list pages
reads "Tasks", like every other page names itself ("Projects", "New
request"). The header keeps showing the project you last opened on every
page, changes the moment you open a different one, and shows nothing until
you have chosen one or while you are signed out.
