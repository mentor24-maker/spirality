# Spirality work log

A plain-English record, newest first, one entry per merged pull request.
Each entry is written INSIDE the pull request it describes. Never edit this
file directly on `main`.

---

## 2026-10-26 — A written plan for leaving ClickUp (#10)

The loops keep every ticket, status and comment in ClickUp, and a lot of
the loop's rules exist only to work around ClickUp's quirks: it cannot tell
Dane from a machine, it cannot refuse a move that two passes race for, and
it rewrites what Dane types. This adds `docs/TRACKER_MVP.md`, the design for
a small tracker of our own: what ClickUp does for us today (every call the
ClickUp script makes is listed), what it costs us, the smallest replacement
(one database file, a web address the loops call, a page for Dane), how the
loops switch over without a rewrite, Dane's four decisions of 2026-10-26,
and the tickets that build it. No code changes.

---

## 2026-10-26 — Answering a question between slices no longer closes the ticket (#9)

Some tickets are built in slices, one pull request at a time. If a loop
asked Dane a question between two slices, the relay saw that the last pull
request was already merged and closed the whole ticket, even though more
work remained (it happened tonight, and a session had to reopen it by hand).
Now the relay checks the ticket's "Next slice:" line first, the same line it
already reads when it merges: if it names more work, the ticket goes back to
the build queue; if it says "none" or there is no such line, it closes as
before. Answering "close it" still closes it either way.

---

## 2026-10-26 — Answering a question now puts the ticket back to work (#8)

When a loop got stuck and asked Dane a question, the ticket sat in "Needs
your input" until someone dragged it back by hand, even after he had
answered. Now the relay, the same background job that merges on his word,
also reads his answer: the next pass sends the ticket back to the build
queue, back to rework if a pull request is already open, or closes it if he
said "close it" or the work has already shipped. It reads every move back,
marks his answer as used so the same reply never moves the ticket twice,
and says so out loud when a move fails. A ticket with no written question
on it is left alone, because without one the relay cannot tell a new reply
from an old one.

After review, three fixes rode along. ClickUp hands over only the newest 25
comments at a time, so on a long ticket the line naming its pull request
could be missed and finished work sent back to the start; every comment
read now pages through the whole history. The relay looks at the ticket
once more right before moving it, so if Dane moved it himself a moment
earlier, his move stands. And the note left when a move fails is read back
and says where the ticket actually is.

---

## 2026-10-14 — Reinstalling the loop jobs no longer leaves a lane stopped (#7)

Reinstalling Spirality's background jobs on the Mac Mini failed twice on
10/14 with "Bootstrap failed", and left the build lane stopped and the relay
not installed. The installer was asking macOS to stop the old job and then,
in the very next breath, to start the new one, but macOS had not finished
stopping the old one yet. The two collided and the installer gave up halfway.

Now the installer waits until the old job is really gone (up to 30 seconds),
then starts the new one, and checks that it is actually running before it
says "Installed". If a job still will not start, it says which one, keeps
going with the others, and ends with a clear failure instead of a quiet one.
A reinstall no longer needs someone who knows the workaround.

---

## 2026-10-13 — The pieces that decide what one pass may do become shared (#5)

The second of three deliveries moving StarCaster's loop pieces into the shared
package. Slice 1 brought the small questions a loop asks about a comment or a
ticket. This slice brings the bigger questions a loop asks about itself before
and after a pass: is too much work already open to claim another ticket? Did
the previous pass drop the ticket it was holding? What should the relay do with
Dane's reply? May this small, safe pull request merge on its own? And when the
two-hour limit stops a pass, what was it actually doing? Five pieces answer
those, five more helpers hold them up, and all of it came across with the
tests written the day each answer was first got wrong.

Two things changed in the move, on purpose. First, as in slice 1, every
sentence that named Dane, StarCaster or StarCaster's log folder now asks the
project's settings file instead, so the same code serves any product. Second,
Spirality's own loop runner learned a trick StarCaster learned the hard way:
when it has to stop a pass at the time limit, it now writes down what the pass
was running, so a stuck test can never again look like a dead machine.

One part of the plan turned out to be wrong when measured, and was corrected
on the ticket before building: five files the plan listed are StarCaster's
description of its own two Macs and scheduled jobs, not shared loop logic, so
they stay where they are until someone decides what a shared version of that
should look like.

---

## 2026-10-13 — Dane's merge word is finally read: Spirality gets its relay (#6)

Until today, when Dane wrote "merge" on a finished ticket, nothing on
Spirality was listening. Two background jobs ran on the Mac Mini: one that
builds tickets and one that reviews them. Neither merges, so his approval sat
there until a person happened to look. On 10/13 that wait was four hours.

Now a third job runs every ten minutes. It reads every ticket waiting on
Dane's go-ahead, and when his comment is exactly one of the agreed merge
words (`merge`, `merge it`, `ship it` or `approve`, nothing more), it checks
everything again on the spot: the ticket is still waiting on him, the review
passed before he spoke, the pull request is open, its checks are green, it is
current with the main branch and it does not conflict. Only then does it
merge, write a short record on the ticket, and move the ticket along, reading
each of those writes back to make sure they landed. If any check fails it
merges nothing and leaves one plain-language note naming what failed. His
word stays good, so the moment that reason clears a later pass merges without
him having to say it twice. "merge PR #4" is not one of the words and does
nothing, on purpose: the exact-phrase rule is what keeps a stray sentence
from shipping code.

Everything the job needs to know about the product, from the merge words to
the name of the background job and where its log goes, comes from the
product's settings file, so the same code will run StarCaster's and
WaveCenter's merges when those products move onto it. Moving an answered
question ticket back into the queue is the next slice.

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

A fourth review found one more, from the first round's fix, and Dane chose one
last round limited to it. JavaScript has two ways to pull in a piece of code —
the older `require` and the newer `import`. The pieces here are written the
older way, and Node works out what an `import` may take from them by reading
their list of names from the top, stopping at the first entry it does not
understand. Round 1 had put a "read the settings when asked" entry near the
top of three lists, so 56 names below it vanished for anyone using `import` —
which is how WaveCenter and Spirality's own ClickUp script are written. It
failed loudly, never silently, but the first product to switch over would have
hit it. Those entries now sit at the end of each list, and a new test checks
every piece in the folder, so a misplaced entry fails `verify` instead of
waiting for a product to find it.

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
