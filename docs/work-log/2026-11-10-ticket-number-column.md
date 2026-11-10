## 2026-11-10 — Add Ticket # column to the Tasks CRUD. (#158)

The tables on the Tasks page used to show each ticket's id (like SP-193) in
small grey text after its name. Now the id has its own column, the first one
on the left, headed **Ticket #**, and the name column shows just the name.
Clicking the id opens the ticket, the same as clicking the name.

Like the other headings, Ticket # can be clicked to sort a stage: lowest
number first, then highest first on a second click. It sorts by the number
itself, so SP-9 comes before SP-10 (sorting as plain text would have put
SP-10 first). The page's once-a-minute refresh keeps that sort in place.

The new column is narrow so the names keep most of the room. A first try
made it a little too wide and squeezed the Last Change dates into the action
buttons; that was seen on the page, fixed, and a test now guards it.
