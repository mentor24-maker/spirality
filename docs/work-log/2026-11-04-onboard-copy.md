## 2026-11-04 — A product's setup copy took three pull requests and three merges: copy and check everything in one (#91)

To run Spirality's loop, a product needs a copy of Spirality's ticket door,
its lane scripts, its main-branch guard and its four loop skills. Normie got
them in three separate pull requests, each needing Dane's "go", a review and
his "merge".

Now one command, `npm run onboard:copy`, writes all of it into one pull
request in the product's repository. It checks by machine that every copied
file is exactly Spirality's, byte for byte, at a named commit. The few files
that must say the product's own name or check command are made by a short
list of exact edits. If Spirality's wording ever changes underneath an edit,
the copy stops and says which file, instead of quietly producing a half-right
copy.

It also fixes something before PressPlay meets it. The review and build
skills now tell a lane's pass how to know it is the lane. Normie's review
lane once stood down because it thought it was a second reviewer, and
copying Spirality's skills as they are would have brought that back.

Tried against Normie, which already has the loop: 46 files came out
identical, 5 are newer door modules it doesn't have yet, and the command
refused to overwrite Normie's own hand-edited skills without being told to.
