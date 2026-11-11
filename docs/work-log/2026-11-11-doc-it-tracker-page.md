## 2026-11-11 — A ticket goes Live while its hand-run steps are still undone: file them as their own ticket, and write this thread's prompts down (#165)

On 2026-11-09 the ticket for pointing spirality.alphire.agency at the
tracker's own page (SP-164) went Live when its pull request merged, but the
actual move of the web address was a step for a person to do afterwards, and
it was written only in a doc. Live hides a ticket from the open view, so the
step was forgotten, and the next day Dane asked why the page had not changed.

The loop's rulebook (docs/LOOP_CONTRACT.md) now says: when a pull request
leaves steps that can only be done after it merges, those steps are filed as
a ticket of their own before the hand-over, so they stay in view. The
tracker's notes (docs/TRACKER_MVP.md) now say how to check the internet route
from the MacBook over ssh, where the plain command fails with
"node: command not found". And the prompts from that hand-run thread are
written down in docs/OPERATOR_PROMPTS.md, next to the ones that landed on
`main` while this pull request waited.
