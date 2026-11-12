## 2026-11-11 — Add 'status' icons under Actions column of Tasks CRUD table (#178)

The Tasks list used to write "your answer is in" after a ticket's name. Now
each row's Actions column starts with a small picture instead. A green check
means your answer is in and the relay owes the next move. A clock means the
ticket is waiting on you, and clicking it takes you to the ticket's reply
box. A row with neither keeps an empty space, so the other icons stay lined
up down the column.

The clocks come from the same rule as the Waiting on You page, worked out for
whoever is signed in, so the two pages can never disagree about what is
waiting on you. Board cards and the ticket page look the same as before.
