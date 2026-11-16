## 2026-11-15 — Give every tracker button one of StarCaster's four kinds (#262)

Before this change, each page of the tracker painted its buttons its own way. On a ticket every button was green, Delete included. On Settings they were dark blue, and the "Set Up a Project" link was black. A disabled button just went faint.

Now every button is one of the four kinds StarCaster uses, so the two products look and behave the same:
- white for ordinary actions;
- blue for the one main action (Merge, Go, Add…);
- green for Save;
- red for anything that removes (Delete, Reject, Remove).

Buttons inside a table are a smaller size. A disabled button turns a paler shade of its own colour instead of fading. Every button shows a blue ring when you reach it with the keyboard.

A new check in `npm run verify` reads the page's code and fails if a button has no kind. The few buttons that draw themselves, such as the small icon buttons, the × that closes a dialog and the sort headings, are listed by name with the reason for each. A new one cannot slip through unnoticed.
