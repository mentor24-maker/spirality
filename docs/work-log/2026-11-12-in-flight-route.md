## 2026-11-12 — Console view of tasks in flight (#194)

The first of three steps toward the Console view, a third way of looking
at tickets beside List and Board, like an air traffic controller's screen.
This step teaches the tracker to answer one question: "which tickets are
in flight, across every project I can see, and what happens to each one
next?" Each ticket comes with its stage, how long it has been there,
whether it is waiting on Dane, its pull request, and which loop picks it
up next and when. When the tracker cannot tell when a loop runs next, it
says so plainly instead of guessing. Nobody sees a project they are not
on. Nothing on the page changes yet: the next ticket draws the Console
tiles from this answer, and the one after adds a colour per feature.
