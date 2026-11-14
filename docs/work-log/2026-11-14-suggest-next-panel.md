## 2026-11-14 — Show suggested next tasks on the Tasks page to reorder and file (#238)

The tracker could already ask Claude to read a project and suggest what to do next, and it could already hold tickets in a set order. Until now nothing on the page used either one. The Tasks page now has a **Suggest Next Tasks** box under Add Task. Press its button and, a few minutes later, the suggestions come back as a numbered list. Drag a row, press the arrow keys on it, or pick a number from its dropdown to change the order, and the other rows renumber to match. Untick any you don't want, then press **File in This Order**. The rest are filed as requests and lined up in the queue in that order.

It is built to be safe to press twice. Each ticket is remembered the moment it is filed, so a retry after a failure never files it again. If a step fails, the box says which one. The demo answers five made-up tasks instead of running Claude, so the box can be tried without waiting or spending anything.

**After review.** Pressing File in This Order a second time (say the next
day, after ticking one more) used to give every earlier ticket a new place,
even ones a loop had already started, and that change makes the loop's next
write on them fail. Now the box reads each earlier ticket back first: only
the ones still in Requested get a place, a started one is left alone, and
one that was deleted or moved is left out and unticked, so a later press
still works. The note names each of those. When the project check cannot
run, the note says so, as Add Task does.

**After the second review.** If a new list came back while File in This
Order was still filing, the box swapped in the new list halfway through, so
a ticket it had just filed showed as not filed and the next press would
have filed it again. Now a list that arrives while filing waits until
filing ends, and File in This Order is switched off while a new list is
being made. The box also opens on its own only when the page is first
opened, so closing it sticks. And a small markup slip stopped the page from
refreshing itself every minute while the list was showing; that is fixed
too.
