## 2026-11-13 — Add a growth rate column to the Reporting page's Task Productivity table (#223)

The Reporting page's Task Productivity table now ends with a Growth Rate
column. A picker in its header chooses Weekly, Monthly or Annual, and each
row shows how much tasks started, and tasks finished, grew or shrank in the
latest week, month or year compared with the one just before it ("+25%",
"-10%").

When there is no honest number to show, it says why instead of inventing
one: "not enough history yet" when the project is too young to have a whole
earlier period, and "none in the period before" when that earlier period had
no tasks at all.

The server does the arithmetic, like every other figure on the page, so
switching the picker is instant and never asks the server again.
