## 2026-11-16 — Record which files each open pull request changes in the tracker (#277)

Two tickets built side by side that edit the same file clash when the second
one merges, and fixing that clash costs a whole extra ticket. On November 16
alone, nine such fix-ups were filed. Until now nothing in the loop knew which
files a pull request touched, so nothing could keep two such tickets apart.

The tracker now keeps that list for every open pull request. When a build
pass records its pull request, the door also asks GitHub for the exact files
it changes and saves them. On every pass the relay looks again, re-reading
any pull request whose branch has moved and forgetting any that merged or
closed. If GitHub doesn't answer, the loop says so and saves nothing, so a
failed read can never pass for "changes no files".

Two ways to use it: the lanes can ask "which open pull requests change any of
these files?" in one command (`npm run clickup -- pr-files`), and each ticket
page shows "Changes the same files as SP-xxx (PR #n)", naming the files.
The next ticket (SP-351) uses this record to hold a ticket back from building
while another open pull request changes the same files.
