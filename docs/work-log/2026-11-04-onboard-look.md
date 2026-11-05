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
