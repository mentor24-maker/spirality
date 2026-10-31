## 2026-10-31 — Dane cannot merge from the ticket page in one click: add a Merge button to Quick Action (#44)

When a ticket is ready for Dane's go-ahead, its page now has a big **Merge**
button at the top right. Before, he had to type the word "merge" into the
reply box. Now he clicks the button, answers one "are you sure?" question
naming the pull request, and the page posts "merge" as his reply for him.
Nothing else changes: the same background job that has always done the
merge still reads that reply, checks everything, and merges.

The word the button posts comes from the project's own settings file, not
from the page, so a product that uses a different word gets that word. The
button only appears on tickets that are actually waiting for a merge, and if
the post fails the page says so in red instead of pretending it worked.
