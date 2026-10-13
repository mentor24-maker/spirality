# Spirality work log

A plain-English record, newest first, one entry per merged pull request.
Each entry is written INSIDE the pull request it describes. Never edit this
file directly on `main`.

---

## 2026-10-12 — The first of StarCaster's loop pieces become shared (#4)

StarCaster's loop has grown to about fifty thousand lines over three months of
real incidents. WaveCenter runs a 1,700-line copy of a much earlier version.
Nothing either one learns ever reaches the other. This is the first delivery
of the fix: twelve of StarCaster's small decision-making pieces now live here,
where both products can share one copy of each.

These are the pieces that answer narrow questions — was this ClickUp comment
written by Dane or by a loop running under his login? Is this ticket genuinely
waiting on him, or does it only look that way? Has review already sent this
ticket back three times? Each answer was got wrong at least once in a real
incident, and each piece carries the tests written the day it was got wrong.
They came across unchanged, tests included, because the tests are the only
proof the move was faithful.

One real change: the pieces no longer have StarCaster's own names written
inside them. Where a sentence said "Dane", it now asks the project's settings
file what to call the operator; where a loop signed a message `[CC-starcaster]`,
it now builds that tag from the product's short name. That is the whole point
of the exercise — the same code has to serve three products without knowing
which one it is running for.

Building it turned up a bug worth recording. The first version worked out which
settings file to read by looking next to its own folder. That is wrong once the
package is installed somewhere else: a copy running inside StarCaster read
SPIRALITY's settings and started signing StarCaster's messages `[CC-spirality]`.
It was caught by installing the package into a scratch project and reading the
tag back, rather than by reasoning about it, and there is now a test that fails
if anyone writes it that way again.

Deliberately unfinished, and Dane chose this shape: this is the first of three
slices, smallest and safest first. The ticket's own list of files turned out to
be incomplete — the pieces it named depend on nine more that it did not, which
is exactly why it is being done in three steps rather than one. Also left for
later, on purpose: pointing this repository's own ClickUp command at the moved
pieces. That looked like a one-line change and is not — the command asks for
fourteen names the moved pieces do not offer, six of which do not exist in
StarCaster's versions at all. Doing it here would have altered the behaviour of
the one tool these loops use to reach ClickUp, so it gets its own ticket.

Forty of the five hundred and sixteen tests are skipped rather than run, and
each one says why: it wants to read a product's own script to check that the
product is really wired up to the piece, and this repository has no such script
yet. The path it looks for is a setting, so whichever slice brings a script
over switches those tests on with nothing further to edit. If the setting names
a script that is not there, the tests fail rather than skip, so a typo cannot
quietly switch the checks off.

Review sent the first version back, and was right to. Four ordinary tests had
been switched off by mistake and are back on. Three places still said "Dane"
outright and now ask the settings file like the rest — so another product's
operator is no longer told something is "WAITING ON DANE". And two pieces read
the operator's name once, when they were first loaded: a loop started by the
Mac's scheduler loads them from a folder with no settings in it, so every card
it stamped would have said "the operator" instead of a name. They now read the
name each time they write it, and a test proves it.

Review sent it back a second time, and found two more things of the same kind.
The list of words that mean "merge it" — `merge`, `ship it`, `approve` — was
still written inside the code, even though the settings file has had a place for
it since the settings work landed. A product that wanted to add a word could not
have merged with it, and one that dropped `approve` would have merged on
`approve` anyway. It now reads that list from the settings, and because all
three products happen to list the same four words today, nothing in service
behaves differently.

The second was worse and is the more interesting of the two. If the settings
file was THERE but had a mistake in it — one key misspelled, `operatorNmae` for
`operatorName` — the code quietly treated it as though there were no settings at
all. Everything fell back to neutral wording: messages signed `[CC-loop]`, cards
saying "the operator" instead of a name, and the product's list of scripts
emptied, which silently switched the wiring checks back off and undid one of the
first round's own fixes. Nothing failed, and nothing said anything. A missing
settings file is an ordinary state and still falls back; a settings file that is
present and wrong now stops with the name of the key it could not understand.

The third fix is about how the first two kinds of mistake kept being found. Some
tests are deliberately switched off here, because they read a product's own
script and this repository has none. That guard had been put on five tests that
read no script at all and were simply switched off by it, and each review round
caught some of them by reading the diff. Reading by eye is what kept missing
one, so there is now a check that does it mechanically: for every switched-off
test, it works out whether the test actually reaches a product's script, and
fails with the file and line if it does not. Run over this slice it found the
one review had named and a second one review had not. It also tests itself
against a deliberately switched-off test, so it cannot pass by looking at
nothing.

Review sent it back a third time, over a bug the second round's own fix had
introduced. Moving the merge words into the settings file made them something a
person types, and people type "Ship it", not "ship it". The matcher tidied up
the COMMENT before comparing — lower-cased it, dropped a trailing full stop —
but compared it against the settings words exactly as written. So a product
whose settings said "Ship it" would have loaded with no complaint and then
never merged on anything: Dane's merge word read and ignored, in silence. While
those words were fixed inside the code this could not happen, because the code
only ever spelled them one way. Both sides are tidied up before comparing now,
so capitals, punctuation, bold and a stray double space in the settings are all
harmless, and the settings file says what it looks like it says. One kind of
word is refused outright instead: a "word" with no letter or digit in it, like
a lone full stop, which tidies away to nothing and would then match an empty
comment — that is, merge on silence. It now stops at load with the entry named.

---

## 2026-10-11 — The loop's rules are written down once (#2)

Until now each product kept its own description of how a ticket moves from
idea to shipped: which statuses exist, who may move a ticket out of each, how
Dane's "merge" comment is recognised, how a loop asks him a question. Those
copies had already started to disagree, and StarCaster's even described a
two-account setup the code stopped using. `docs/LOOP_CONTRACT.md` is now the
one description, checked line by line against StarCaster's code, with the
real incident behind each rule. Each product will link to it instead of
restating it, so a lesson learned in one product reaches the others.

The first draft was sent back by review for stating some rules more strictly
than the code keeps them. The contract now says which rules a script
enforces, which are only written in a skill, and which are list conventions.
It names every override flag. It describes StarCaster's auto-merge lanes,
which merge test, document and tooling changes after an hour without a word
from Dane. And it gives the true status order of all three lists.

## 2026-10-11 — One file holds every product-specific id (#3)

The ClickUp door had Spirality's ids (its queue, its space, Dane's seat)
typed straight into the code. That is fine for one product and wrong for a
shared one: the same code has to work StarCaster's queue and WaveCenter's.
Now those values live in one small file, `spirality.project.json`, and the
code reads them from there. If a value is missing or mistyped, every command
stops straight away and names the setting at fault, instead of quietly
working the wrong queue. Each product will get its own copy of that file;
the code stays the same for all three.

## 2026-10-11 — Spirality is born: the seed loop, copied from WaveCenter (#1)

Dane decided that the development loop StarCaster and WaveCenter each run a
copy of becomes its own Alphire product, Spirality, in its own repository.
This first pull request gives the repository the seed loop WaveCenter has run
since 2026-10-11, pointed at Spirality's own ClickUp queue: the ClickUp door,
the loop runner and its installer, the three skills, the no-edits-on-main
hook, the secrets scan, and `npm run verify` as the one definition of done.
From here Spirality's own loops do the real work: moving StarCaster's loop
modules into a shared package that both products install.
