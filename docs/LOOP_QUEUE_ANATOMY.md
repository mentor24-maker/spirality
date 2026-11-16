# Loop Queue Anatomy

The Spirality Loop Queue diagram shows the eight statuses a ticket moves
through, from Dane's first words to merged work, and the labelled arrows
between them. Each section below explains one box: what it means, who owns
it, and what moves a ticket in and out. Each has its own anchor, so a link
can open this page at that status (`#rework`, `#ready-to-launch`). The rules
themselves, with the incidents that earned them, live in
[docs/LOOP_CONTRACT.md](LOOP_CONTRACT.md) ("The eight statuses" and "Who may
move a ticket, and how"); this page only describes them.

## Requested

Requested is where every new idea starts. When Dane types a request into the
tracker page, the ticket is created in this status, holding his own words
and nothing else. Nobody has written it up yet, so it is not a spec: there
are no acceptance criteria, no test steps and no list of files to change. No
build loop ever claims one: a guess at what he meant is how the wrong thing
gets built. The status belongs to the machine, and one lane in particular:
loop-intake, which runs on the Mini on its own timer. Each pass takes the
oldest Requested ticket and turns it into a proper spec, with his words kept
verbatim under a first "Asked" heading. A request too big for one pull
request is sliced into several tickets, and every further slice is filed in
Requested too, so no build loop can reach it early. The one arrow leaving
this box is labelled "Written up as a spec". Intake moves the ticket to
Needs your input with an operator card asking him to reply "go" to queue it,
or to say what to change. A request too unclear to spec gets its question on
the card instead, and nothing else changes.

## Needs your input

Needs your input is the first of Dane's two statuses, the box the diagram
calls "Needs input". A ticket here is waiting on an answer that only he can
give, and while it sits here no loop may take it back out. Moving a ticket
into this status assigns him, so it shows in his own view, and only the
`ask` command may put it here, always with an operator card ending in his
move. Two arrows arrive. "Written up as a spec" comes from Requested, when
intake hands him a new spec to approve. "Judgment call" comes from In
review, when review finds a question only he can settle, or when a ticket
would be sent back a fourth time: three rounds means the spec was wrong, not
the builder. Build loops escalate here too, when the gates fail for a reason
outside the ticket, or the work is too vague or too big. The arrow leaving
is "Operator says go". His reply, or a teammate's, is the answer, and the
relay carries it out. With no pull request yet the ticket goes to Queued.
With one still open it goes to Rework. If his reply says to close it, or its
pull request already merged, it goes to Live.

## Queued

Queued is the line of specced work waiting for a builder. Every ticket here
has a description written as a spec, with a goal, a scope, things it must
not do, acceptance criteria and test steps, and Dane has said go. The status
belongs to the machine. The diagram draws the box as a stack of slots
because order matters. The label under it reads "Highest priority first,
then oldest". A build pass takes the most urgent ticket first, urgent before
high before normal before low. Within one priority a ticket with a place in
the queue, set by putting tickets in order on the tracker page, comes before
one without, lower place first; place never beats priority. Then oldest
first. Two things can hold a Queued ticket back. A "Waits on:" line naming
another ticket that is still open keeps it out of line until that ticket
closes. And no Queued ticket is taken while any Rework ticket waits, because
finishing half-built work comes before starting new work. The arrow arriving
is "Operator says go", from Needs your input. The arrow leaving goes to
Building, when a build pass claims the ticket with the `claim` command,
which refuses if the ticket moved first.

## Rework

Rework is where a ticket goes when review sends it back. It is not new work:
a branch, an open pull request and the reviewer's notes all already exist,
and the job is to fix what the notes named and push to the same pull
request, never to start a second branch. The status belongs to the machine.
The red arrow arriving is labelled "Sent back": loop-review found a real
problem and moved the ticket here from In review with a written verdict. It
can also arrive from Needs your input, when Dane answers a ticket whose pull
request is still open. Under the box the diagram reads "Oldest first
(priority ignored)". Rework is ordered by when the ticket was created, not
by its priority, because priority says what to start, and rework is not
started, it is finished. The arrow leaving reads "Rework is always taken
first": a build pass takes every Rework ticket before any Queued one. Rework
became its own status on 31 August 2026. Before that a send-back returned to
Queued, where it looked exactly like work nobody had started; half-built
tickets lost their place in line and went stale behind fresh high-priority
work, and the count of work in progress was wrong.

## Building

Building means a build pass has claimed the ticket and is writing the code.
The status belongs to the machine, and to one pass at a time: claiming is a
read, a comparison and a write, which is only safe because just one build
lane runs per project and its passes run one after another. Two arrows
arrive, one from Queued and one from Rework, and the `claim` command makes
both moves, refusing if the ticket moved underneath it. Inside Building the
pass works in its own copy of the repository on its own branch, builds
exactly what the spec describes, and runs `npm run verify`, the one name for
every check, which the pull request must pass. It writes a plain-English
work-log entry, opens the pull request with the ticket's exact name as its
title, and records it on the ticket. The arrow leaving is "Pull request
opened", to In review. A pass may never end with its ticket still here,
because no loop claims from Building, so a ticket left behind is
unreachable, not late. Before it reports, the ticket is in In review, handed
back to Rework or Queued with a note saying why, or escalated to Needs your
input.

## In review

In review means the pull request is open and waiting for, or getting, an
independent check. It belongs to the machine: loop-review, a separate lane
that did not write the code and checks it with fresh eyes. The arrow
arriving is "Pull request opened", from Building, and a build pass moves the
ticket here only after the pull request exists, its body links back to the
ticket, and the `pr-opened` command has recorded it. A review pass first
marks the ticket as being checked. It then runs `npm run verify` itself,
reads the code against the spec's acceptance criteria, and walks the
ticket's test steps for real. Three arrows leave, and this is the only box
with a choice. "Passes" goes to Ready to launch, once a passing verdict is
written on the ticket. "Sent back", the red arrow, goes to Rework with notes
naming what to fix. "Judgment call" goes to Needs your input, when the
question is one only Dane can settle, or when a fourth send-back would be
due: a ticket may be sent back three times, and after that the spec is the
problem, not the builder. Every verdict names the status it expects and
writes nothing if the ticket has moved.

## Ready to launch

Ready to launch is Dane's second status, and it asks him for a yes, not an
answer. Everything a machine can check is done: the work was built,
independently reviewed and passed, and `npm run verify` is green on the pull
request. All that is left is his word to merge. Moving a ticket here assigns
him, so it appears in his own view, and only the `ask` command may put it
here, and only when the newest review verdict on the ticket is a pass. That
guard dates from 22 August 2026, when two unreviewed tickets got here. The
arrow arriving is "Passes", from In review. The arrow leaving is "Operator
merges", to Live. He replies on the ticket with a merge phrase, and the
relay, the pass that carries out his comments every few minutes, checks
every gate again before it merges the pull request and closes the ticket. No
build or review loop merges anything and no loop takes a ticket back out of
this status: once it is handed to him, it stays handed to him until he acts.
On StarCaster, and only there, two auto-merge lanes may take a ticket on to
Live after an hour in which he did not object, under a standing policy he
ruled on.

## Live

Live is the last box: the work is merged and shipped, or the ticket was
deliberately closed. It belongs to nobody, because there is nothing left to
do. In a ClickUp list it is a closed-type status, which is what makes
finished work leave the open view, and it is the only finished status the
loop's own status list names; complete, closed and done are not synonyms.
The main arrow arriving is "Operator merges", from Ready to launch, when the
relay merges the pull request on Dane's word and closes the ticket. Other
routes reach Live without a merge. When he answers a question card on a
Needs your input ticket by saying to close it, the relay closes it. A small
fix-up ticket whose pull request is found already merged is closed by the
loop with a note naming the merge, and nobody is asked. There is no "Won't
do" status: work that is not going to be built is closed as Live with a
`wont-do` tag and a comment saying what was decided. No loop moves a ticket
to Live on its own judgement; only a merge he authorized, or his decision to
close it, does. On StarCaster the auto-merge lanes are the one exception,
merging under a policy he set.
