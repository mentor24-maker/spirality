## 2026-11-09 — Links to a pull request's files go dead when Dane merges: link by commit, never by branch (#136)

When a loop pointed Dane at a file in a pull request, it linked by the
branch's name. Merging deletes the branch, so the link broke right after he
merged: on 2026-11-04 he clicked "Read the page" on SP-105 and got GitHub's
"page not found".

Now the ticket command checks every comment, card, description and new ticket
before writing it. If a GitHub file link names a branch, nothing is written,
and the loop is told the link and what to use instead: a link to the exact
commit, which never goes away, or `main` for a file already merged, or the
pull request's list of changed files. The four loop instructions and the loop
contract say the same, so the loops get it right the first time instead of
being caught.
