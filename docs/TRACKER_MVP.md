# Leaving ClickUp: the tracker MVP

Proposed and decided 2026-10-26. Dane agreed to every recommendation under
"Decisions" below; the build tickets are in the Spirality Loop Queue under
the `tracker` tag.

## The idea in one paragraph

Spirality uses ClickUp as a shared notebook between Dane and the loops: a
list of tickets, each with a status, a description and a comment thread. We
use a small part of what ClickUp does, and a large share of the loop's code
exists to work around the way ClickUp behaves (who wrote a comment, two
passes racing, text it deletes, limits it imposes). This document lists
exactly what the loop asks of ClickUp today, then designs the smallest
tracker of our own that does those things and nothing more. Everything else
is built out from that core later, one ticket at a time.

## What ClickUp does for us today

Taken from `scripts/clickup.mjs` (every API call it makes), the package
modules in `lib/`, the three skills and `docs/LOOP_CONTRACT.md`.

### Things the loop reads and writes

| What | How we use it | Where |
|---|---|---|
| **Lists** | One Loop Queue per product. Workspace and space ids exist only to find the list. | `spirality.project.json`, `lists` |
| **Tickets** | Name, description (Markdown), created and updated dates, a link we put in PR bodies. | `queue`, `get`, `task`, `describe` |
| **Status** | Exactly the seven in the contract. `Live` must be a "closed" status so finished work leaves the open view. | `claim`, `status`, `ask`, `relay` |
| **Priority** | Four levels, used only to order `Queued` tickets. | `priority`, `claimOrder` |
| **Tags** | `wont-do`, `deferred`, epic names. Nothing in code acts on them. | `tag` |
| **Assignee** | Only ever Dane or nobody. It is the hand-off signal, not a work assignment. | `status`, `ask` |
| **Comments** | The whole trail: `PR opened:`, `REVIEW:` verdicts, operator cards, Dane's answers and merge words. | `comment`, `comments`, every reader in `lib/` |
| **Threaded replies** | The relay replies on Dane's comment with a `[merge-on-comment]` marker so it never acts twice on one word. | `relay` |
| **Loop note** | One short text field (255 characters) saying what is happening now. | `lib/loopNote.js` |
| **Who wrote it** | Each comment carries a user id. | `waitingOnOperator`, `mergeOnComment` |
| **The token's own user** | `whoami` checks the token and shows whose seat it is (Dane's, which is why every comment carries the machine stamp). | `whoami` |

### Things Dane uses as a person

- **"Assigned to me"**, across every product: his one view of what waits on
  him.
- **Notifications**, so he hears about a handed-over ticket without
  looking.
- **A comment box** to answer a card or type "merge".
- **A board** to see the shape of a queue at a glance.

### Things we do not use

Subtasks, due dates, time tracking, checklists, attachments, ClickUp Docs,
custom views, automations, webhooks (the relay polls every 10 minutes),
@-mentions, multiple people, permissions. StarCaster also uses a second list
("Agent Response", called the bus) as an alarm channel; Spirality does not.

## What ClickUp costs us

Each of these is a rule in the contract, written after an incident, that
exists only because of how ClickUp works. A tracker of our own removes the
cause, not just the symptom.

| Workaround today | Why it exists | In our own tracker |
|---|---|---|
| The `[machine]` stamp on every comment, and the rules for reading it | Every loop posts under Dane's token, so the user id cannot tell Dane from a machine (2026-09-01) | Each loop has its own identity. The author is a fact, not a guess. |
| Check-then-write claims, `--if-status` on every move, one build loop per product | ClickUp cannot change a status only if it is still what we read (2026-08-22, two reviews racing) | A move names the status it expects and the store refuses atomically. Two passes can never both win. |
| "No blockquotes" in cards, read-back of Dane's words | ClickUp silently deletes quoted lines on save | Text is stored as written. |
| Stripping code fences and bold from merge phrases | ClickUp's editor reformats what Dane types (2026-09-01, 2026-09-06) | Our reply box sends plain text. The normaliser stays as a safety net. |
| The Loop note refusing writes | The workspace ran out of "custom field usages" | A plain column. |
| Comment paging, rate-limit handling, timeouts | API limits, and the claude.ai connector's shared budget | Local reads, no third-party limit. |

None of the contract's *decisions* change: the seven statuses, who owns
which, the card, the markers, the merge phrases, the waiting verdicts. Only
the place they are stored moves.

## The MVP

### What it is

A small program, plain Node with no outside packages, that keeps tickets and
comments in one SQLite database file (SQLite is a database that lives in a
single file; Node 22, which we already run, has it built in as
`node:sqlite`. On Node 22.23 it loads without a flag but prints
"ExperimentalWarning: SQLite is an experimental feature" once per run; the
store ticket should expect that line). It offers:

1. **An HTTP API** (a set of web addresses the loops call) that the door
   uses instead of ClickUp's.
2. **A web page for Dane** to see and work the tickets, built for his
   desktop browser (where he works today; a phone layout comes later).

### The data

Five tables. That is the whole model.

```
projects  slug, name, operator actor        -- replaces workspace + space + list
actors    id, kind (human|machine), name, token hash
tickets   id, project, name, description, status, priority, tags,
          assignee, loop_note, created_at, updated_at, version
comments  id, ticket, parent (for replies), author, body, created_at
events    id, ticket, actor, what changed, from, to, at   -- written by the store, never by callers
```

- **Comments are append-only.** Nothing edits or deletes one, so the trail
  the loop reads can never shift under it.
- **`version`** goes up by one on every change to a ticket. A write may say
  "only if the version (or status) is still X", and is refused if not. This
  is the atomic claim.
- **`events`** is the history: every move, with who made it and when. It
  makes "every write is read back" cheap, and it is the audit trail ClickUp
  never gave us.
- Ticket ids are short and readable (`SP-42`), and a ticket's address is
  `<tracker>/t/SP-42`.

### The API

Every call carries the caller's own token. The answers are JSON (structured
text programs read).

| Call | Does |
|---|---|
| `GET /me` | who this token is |
| `GET /actors/:id` | an actor's id, kind and name (never a token), for showing who wrote a comment |
| `GET /projects/:slug/tickets?status=&open=` | the queue |
| `POST /projects/:slug/tickets` | file a ticket |
| `GET /tickets/:id` | one ticket with its comments, oldest first |
| `PATCH /tickets/:id` | change status, priority, tags, assignee, description or Loop note, with optional `ifStatus` / `ifVersion`; answers 409 ("conflict") and writes nothing if the ticket has moved |
| `POST /tickets/:id/comments` | a comment, or a reply when `parent` is given |
| `GET /tickets/:id/events` | the history |
| `GET /waiting` | for Dane's page: tickets in the operator's two statuses across every project, by the loop's own `waiting` verdict for the caller, newest first |
| `GET /tickets/:id/thread` | for Dane's page: the ticket with each comment's author named and machine comments marked |

The store enforces only what keeps the data true: valid statuses, the
atomic guards, authorship from the token. The contract's rules (only `ask`
sets Dane's statuses, the card checks, the PASS gate) stay in the package
modules and the door, exactly where they are tested today. Moving them into
the server is a later, separate decision.

### Dane's page

Part of the MVP, not an add-on: without it Dane cannot see or answer
anything once ClickUp is gone. Desktop browser only. Three screens, nothing
more:

1. **Waiting on you**: tickets in his two statuses, across every product,
   newest first. This is the one view he uses today.
2. **A ticket**: the description, the comments (cards drawn with the red
   `NEEDED FROM DANE` banner, machine comments visibly marked as such), and a
   reply box. He answers and says "merge" here.
3. **A board** per product: read-only columns of the seven statuses.

The page is served by `tracker/server.mjs` at `/` (a ticket at `/t/<id>`)
from `tracker/web/`. `node tracker/demo.mjs` starts a throwaway tracker
with test data to try it.

Sign-in is a single password for Dane in the MVP. The page shows a count of
tickets waiting on him in the browser tab's title, so a pinned tab tells him
at a glance.

### How the loops switch over without a rewrite

The modules in `lib/` read ClickUp-shaped objects (`comment_text`,
`user.id`, `date`). Rather than change them, the door gets a seam:

1. **The door talks to a "tracker", not to ClickUp.** Two implementations:
   the current ClickUp one, and ours, which hands back objects of the same
   shape. The project config says which one a product uses. Every command,
   guard and test stays as it is. (This is the same move-don't-rewrite rule
   as Phase 1.)
2. **The machine stamp keeps being written** while both trackers exist, so
   the readers stay correct on either. It is retired in a later ticket, once
   no product reads ClickUp.
3. **An importer** copies a product's Loop Queue, tickets and comments, into
   the new store, and keeps a map from old ClickUp ids to new ones, so old
   PR links still resolve.

### The order

1. **Spirality first.** It is the smallest queue and its own first customer.
   Import, switch the config, run both loops for a week. ClickUp's list stays
   read-only as the archive.
2. **WaveCenter**, then **StarCaster** (which also needs the bus, see below),
   each by changing its config and importing its queue.

This fits the existing plan: Phase 2 moves the door into the package. The
seam should be built as part of that move, so we do not carry ClickUp's door
into the package only to cut it open again.

### Not in the MVP

Built later, from this core, only when a real need appears: a phone layout
and phone notifications, the bus (StarCaster's alarm list),
search, attachments, more than one person, per-client environments, live
updates instead of the relay's 10-minute poll, server-side contract rules.

## Decisions (Dane, 2026-10-26)

Dane agreed to all four recommendations:

- **It runs on the Mini**, reached from his desktop over the home network.
- **He hears about a hand-over** from the waiting count in the tab title and
  an email.
- **Its name is "the tracker".**
- **The order stands**: Spirality first with a week side by side, then
  WaveCenter, then StarCaster.

The options as they were put to him:

1. **Where it runs.** Recommendation: on the Mini, next to the loops, with
   the database file backed up nightly. The loops are already there, it
   costs nothing, and it keeps rule 8 (plain Node, nothing host-specific).
   Because he works only at his desktop, his browser reaches it over the
   home network; reaching it from outside waits for the phone layout. The
   alternative is a small hosted server, which costs a few dollars a month
   and is reachable anywhere, but adds a second place to keep running.
2. **How he hears about a hand-over.** ClickUp's notifications do this
   today, and the MVP must not leave him blind. Recommendation: the waiting
   count in the tab title, plus an email when a ticket enters one of his
   statuses. A desktop notification from the page is the alternative.
3. **Its name.** Working name: "the tracker".
4. **Go or no-go on the order above**: Spirality first, a week side by side,
   then the products.

## The tickets

Filed with `loop-spec` in the Spirality Loop Queue, tag `tracker`, each one
pull request. They build in this order; each ticket's description names the
one before it.

1. The store: the five tables, the atomic guards, the events log, with tests.
2. The API over the store, with per-actor tokens.
3. The tracker seam in the door, with the ClickUp implementation behind it
   and no behaviour change.
4. The tracker implementation of the seam, passing the door's existing tests.
5. The importer, with the old-id map.
6. Dane's page (desktop): Waiting on you, the ticket, the reply box.
7. The board, the waiting count in the tab title, and the hand-over email.
8. Switch Spirality over, and the runbook for the week side by side.
