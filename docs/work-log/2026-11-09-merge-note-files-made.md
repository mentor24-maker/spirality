## 2026-11-09 — Link to generated artifacts (#141)

When a ticket makes a new file, Dane should be able to open it from the
ticket. On PP-2 he couldn't: the ticket made `docs/OVERVIEW.md`, the only link
to it pointed at the work branch, and merging deleted that branch, so the link
went nowhere.

Now, after the relay merges a pull request and has checked the merge really
happened, it asks GitHub which files that pull request created and adds a
"Files made by this ticket" list to its merge note, each file linked on the
main branch, where it lives for good. A long list stops at 20 and points to the
pull request for the rest. If GitHub's answer can't be read, the note says so
plainly rather than showing a list that might be wrong, and the merge still
counts.
