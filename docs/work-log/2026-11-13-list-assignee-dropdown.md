## 2026-11-13 — Allow change of Assigned To in CRUD table (#226)

On the Tasks page's List view, who a ticket is assigned to can now be changed
right from its row, with a dropdown, the same way its priority already could.
The dropdown offers exactly what the ticket's own page offers (the project's
operator, or Nobody), and saves the moment you pick, saying "Saving…" then
"Saved". If a loop changed the ticket while you were looking, nothing is
overwritten: the list shows what is stored and says why. The priority and
assignee dropdowns now share one piece of code, so they always behave alike.
The board's data gained two new fields to make this work, and every field an
outside site already reads is unchanged.
