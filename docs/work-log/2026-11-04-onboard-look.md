## 2026-11-04 — Dane cannot see whether a product is ready to set up before anything is changed: a read-only look (#89)

Setting up Normie turned up its problems one at a time, each after
something had already been changed: a check that was already failing, a
GitHub plan that would not protect the main branch, a folder in the wrong
place. The setup wizard's first step now looks before it touches anything.

One command, `npm run onboard:look`, reads the product's answers (its name,
GitHub repository, ticket prefix and the rest, kept in one file outside the
public repository, the same file every later setup step will read) and
checks GitHub, the Mini, the tracker, Doppler and the product's own check
on a fresh copy of its code. It prints one line per item: ready, will do
(a later step does it), BLOCKED with the reason, or "could not tell", which
is never dressed up as ready. It writes nothing anywhere, and a test proves
it: every call it makes is checked against a list of read-only ones.

Run on the Mini, it already earned its keep: Normie's own check failed on a
fresh copy there although it passes on GitHub, and PressPlay has no check to
run yet. This is the second of the six tickets that make product setup one
guided step.

After review: the Node line read some ordinary version rules wrongly, so it
could call a fitting Node BLOCKED or an unfitting one ready ("at most 22"
now means anything in the 22s; "above 22" means 23 or later; "about 22.12"
means 22.12 patches only). A Node version it cannot read now says "could not
tell". The checkout line also refuses a folder that sits inside some other
checkout, `--product normie` refuses a file written for another product, and
the look and `npm run doctor` now share one way of deciding two GitHub
addresses are the same repository.

Second review round: when GitHub cannot say which branch is the main one, the
checkout line now says "could not tell" instead of "ready" for whatever branch
the folder happens to be on. An empty clone (a checkout with no commit yet) is
now called that, not "not a git checkout". A Node range written with a space
after its sign (`>= 22.12`, which npm accepts) is read instead of refused, and
a GitHub address ending `.git/` is recognised as the same repository.

Third review round: when the folder turns out to be a copy of some other
repository, the checkout line used to print that copy's address exactly as git
stored it, and an address can have a sign-in token written into it. The line
now names only the repository (`other/repo`), with any sign-in part taken out,
whatever site it is on, so a token cannot reach the screen or a log. A folder
typed with different capitals (`~/WebApps/Normie` for `.../normie`) is now
recognised as the same folder, the way the Mac's disk treats it, instead of
being called "inside another checkout". And the "empty clone" line now appears
only when git actually says the checkout has no commit yet. Any other git
failure says "could not tell", with git's own words.
