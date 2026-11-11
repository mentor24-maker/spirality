## 2026-11-10 — Add a Ticket number lookup to task search (#171)

The Search page has a new "Ticket number" box beside the Project filter.
Dane can type a ticket's number (in any case, `sp-12` is fine) and press
Enter, or pick it from the list the box offers, and the ticket's page
opens straight away, without searching for words first.

The list follows the Project filter: one project's tickets when one is
chosen, finished ones included, or every ticket he can see when it is on
"Any". Someone who can see only some projects is never offered a ticket
from another one. A number that isn't on the list says so in one plain
line ("No ticket SP-999 in Spirality") instead of leaving a blank page.
