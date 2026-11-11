## 2026-11-11 — Add the ability to change priority (#180)

Until now, the only place to change a ticket's priority was the Change panel on the ticket's own page. The Tasks page's List view just showed it as text. Now each row's Priority is a dropdown: pick Urgent, High, Normal or Low and it saves right away, with "Saving…" and then "Saved" beside it.

It saves the same way the ticket page does, with a version check, so it can never overwrite a loop's move. If a loop moved the ticket while the list was open, the page says so and shows the list as it really is. If the tracker refuses for any other reason, its words show beside the dropdown and the old value comes back. To make that check possible, the board's answer now includes each ticket's version number. Nothing was removed from it, so outside sites that read it are unaffected. The Board view's cards stay as they were.
