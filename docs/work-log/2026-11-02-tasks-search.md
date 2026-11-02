## 2026-11-02 — Add Search field to the Tasks page (#63)

The Tasks page now has a search box. Type a word or phrase and press Enter,
and the tracker lists every ticket in every project that mentions it,
finished tickets included, best matches first, with the word in bold.

"Best" follows the order Dane gave: a ticket whose title has the word comes
first, then one with it in the description, then one where a person
mentioned it in the comments, and last one where only a loop's notes
mention it. Each result shows a short piece of the text where the word was
found and says where that was, so it is easy to tell why a ticket came up.

Ticket text is made safe before the bold is added, so a ticket that
contains web-page code (the demo has one) shows that code as plain words
instead of running it. Searching only reads; it never changes a ticket.
Filters for status, priority and people come next, in SP-83.
