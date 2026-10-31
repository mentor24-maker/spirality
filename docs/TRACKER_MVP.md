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
| `GET /projects` | for Dane's page: every project with its slug, name, ticket prefix and open count, and the project the New request form starts on |
| `GET /projects/:slug` | for Dane's page: one project's details, its operator by name, its open count and a count per status; 404 for an unknown slug |
| `GET /projects/:slug/board` | for Dane's page: one project's tickets in the eight statuses, each in `queue` order |

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
from `tracker/web/`. `/projects` is a table of every project: choosing a
name selects it and opens its tasks, and the View icon in its Actions column
opens `/projects/<slug>`, that project's details (prefix, operator, open
count, a count per status) with links to its board and list. A browser
opening `/projects` or `/projects/<slug>` gets the page; the page's own
call to the same address gets the data. `node tracker/demo.mjs` starts a throwaway tracker
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

## Running it

The tracker runs on the Mini as two launchd jobs (launchd is the Mac's own
service manager: it starts a job at login, restarts it if it stops, and
survives a reboot). `scripts/install_loop_runner.sh` installs them beside the
loop lanes, but only for a product whose project config names a
`trackerPort`; a product without one gets no tracker jobs.

| Job | What it does |
|---|---|
| `<launchdPrefix>.tracker` | Runs `tracker/server.mjs`, kept alive: if it stops, launchd starts it again within seconds. |
| `<launchdPrefix>.tracker-backup` | Runs `tracker/backup.mjs` every night at 03:15 Mini time. |

The settings come from the project config (`spirality.project.json`):

- **`trackerPort`**: the port it listens on (Spirality: `4180`).
- **`trackerHost`**: `0.0.0.0` lets every machine on the home network reach
  it, so Dane's desktop opens `http://<the Mini's address>:4180`. Leave it out
  for `127.0.0.1`, the Mini only. Nothing outside the home network can reach
  it either way unless the router is told to forward that port, which it is
  not. The first start may make macOS ask whether `node` may accept incoming
  connections; answer Allow.
- **`trackerDataDir`**: the folder holding everything (Spirality:
  `~/spirality-tracker`):
  - `tracker.db`: the database (with `tracker.db-wal` and `tracker.db-shm`
    beside it while the server runs; they belong to it, never delete them).
  - `backups/tracker-YYYY-MM-DD.db`: one copy per night, the newest 14 kept.

Logs are in the configured log folder: `<productSlug>-tracker.log` (one line
per request: method, address, answer, actor id; never a token) and
`<productSlug>-tracker-backup.log` (one `backup OK` or `backup FAILED` line
per night).

**The hand-over email** goes out through Resend (Dane's choice,
2026-10-28) when a ticket enters one of his two statuses. The server reads
two names from the project's Doppler config when it starts: `RESEND_API_KEY`
(the service's key) and `TRACKER_NOTIFY_TO` (his address). With either one
missing, or Doppler unreadable, the server runs with the email off and says
so once in its log. After adding or changing them, restart the server so it
reads them again:
`launchctl kickstart -k gui/$(id -u)/<launchdPrefix>.tracker`.
`npm run tracker:test-email` sends one test hand-over through the same code,
from a throwaway tracker in memory, without touching the real one.

**A backup is made by SQLite itself**, not by copying the file: copying a
database while it is being written can catch it half-done. `VACUUM INTO`
reads the whole database at one moment while writes carry on, the copy is
checked with SQLite's own integrity check, and only a copy that passes is
given its dated name. A failed night says `backup FAILED` and why, and
leaves the older backups alone.

### Sign-ins

Every actor signs in with its own token, so the tracker records who really
made each move. The tokens live only in Doppler (project `spirality`, config
`dev`); this repository holds their names, never their values.

| Actor | Kind | Doppler secret | Used by |
|---|---|---|---|
| the operator (`operatorName`, "Dane") | human | `TRACKER_TOKEN_OPERATOR` | Dane, to sign in to the page |
| `loop-build` | machine | `TRACKER_TOKEN_LOOP_BUILD` | `scripts/loop_runner.sh loop-build` |
| `loop-review` | machine | `TRACKER_TOKEN_LOOP_REVIEW` | `scripts/loop_runner.sh loop-review` |
| `loop-intake` | machine | `TRACKER_TOKEN_LOOP_INTAKE` | `scripts/loop_runner.sh loop-intake` |
| `relay` | machine | `TRACKER_TOKEN_RELAY` | `scripts/run_relay.sh` |
| `hand-run` | machine | `TRACKER_TOKEN_HAND_RUN` | a session started by hand (no runner) |

The list is `TRACKER_SEATS` in `scripts/lib/expectedSecrets.mjs`, so
`npm run doctor` reports each one as present or MISSING.

A runner never handles the token itself. It sets `TRACKER_TOKEN_NAME` to
the secret's **name** (`loop_runner.sh` derives it from the skill: `loop-build`
→ `TRACKER_TOKEN_LOOP_BUILD`), and the door reads that secret inside its own
`doppler run`. The value never enters the loop session's environment or its
log. Only the machine seats can be named: the door refuses
`TRACKER_TOKEN_OPERATOR` (or any other name), so no loop can sign in as the
operator. A session started by hand (the switch session, a debugging
session) names none and signs in as `hand-run`, its own machine seat, so
the tracker shows its moves apart from the loops' and never as the operator's.
Until the switch-over, Spirality's `tracker` is still `clickup`, so none of
this is read yet.

Making them, once, **on the Mini**, the machine the tracker runs on (it uses
the database at `trackerDataDir`). Doppler is shared by every machine, but
the database is the Mini's alone, so both commands belong there:

```bash
npm run tracker:signins -- create --name Spirality
npm run tracker:signins -- check
```

Run anywhere else, `create` changes nothing. With no database at
`trackerDataDir` it stops before touching anything:

```
There is no tracker database at /Users/<you>/spirality-tracker/tracker.db, so this is not the machine the tracker runs on. Nothing was made or written. Run it on the machine the tracker runs on (mac-mini.local). ...
```

With some other database there, it proves each token at the tracker
before Doppler sees it. "The tracker" is found from the network address in
the project config **file** (`trackerUrl`, `http://mac-mini.local:4180`),
never from Doppler's same-machine `TRACKER_URL` override, which would ask
whatever tracker runs on the machine at hand (a test one on a laptop, say).
On the machine that address names, it is asked at `127.0.0.1` on the same
port, because Node cannot look up the machine's own `.local` name (#28);
anywhere else, by that name. The first line says which:

```
tokens asked of: the tracker at http://127.0.0.1:4180 (this machine is mac-mini.local, where it runs)
```

A new token the tracker does not know is revoked on the spot, nothing is
written to Doppler, and no later seat is tried:

```
TRACKER_TOKEN_OPERATOR: REFUSED. Actor 1 ("Dane") was given a new token here, but the tracker at http://127.0.0.1:4180 answered 401, not "Dane" (human): this database is not the one the tracker at http://127.0.0.1:4180 serves. Run this on the machine the tracker runs on (mac-mini.local). Nothing was written to Doppler; the new token is revoked.
```

Tokens already in Doppler that work at the tracker but not in this
database mean the same thing: the wrong database, so it changes nothing and
says to **keep** them (only a token dead both here and at the tracker is
called stale, with "remove that secret in Doppler"):

```
TRACKER_TOKEN_OPERATOR: WRONG. Doppler's token signs in as "Dane" at the tracker at http://127.0.0.1:4180, so it is good, but not in this database: this database is not the one the tracker at http://127.0.0.1:4180 serves. Run this on the machine the tracker runs on (mac-mini.local). Nothing changed; keep that secret.
TRACKER_TOKEN_LOOP_BUILD: NOT tried, because of the seat above. Nothing changed.
```

A tracker that is down or failing (no answer, or a 5xx) is reported as
exactly that ("did not answer ..., so no token can be proven. Run it again
once the tracker is up"), never as the wrong machine.

`check` asks the tracker itself, the same way, so a token that only works
against some other machine's database is called WRONG. `check --local`
asks a private server on this machine's database instead, which says
nothing about the tracker everyone uses. The first-ever setup, before the
tracker has run anywhere, gives `create --new-database`: that makes the
database and proves the tokens against a private server on it, and says so.

`create` makes each actor (with `tracker/admin.mjs`'s store calls), puts each
token straight into Doppler, reads it back from Doppler, records the
operator's actor as the one the history import (`tracker/import.mjs`) stands
for his ClickUp seat, then makes the `spirality` project with the operator as
its operator and the config's `trackerPrefix` as its ticket prefix (`--prefix`
may be given, but must match). Without that record, the import would make a
second operator and file all of his history under it; the import now refuses
a project whose operator is not the one his seat maps to. Running `create`
again finishes what a failed run left, records that mapping on a database
made before it existed, and never replaces a working token. `check`
asks the tracker `GET /me` with each token and expects that actor's own name back. To
replace a lost or leaked token, delete that secret in Doppler and run
`create` again: the same actor gets a new token, and the old one stops
signing in.

### Checking it

```bash
./scripts/install_loop_runner.sh --status
```

The `tracker` section should say `loaded: yes` with a number (the running
process) and `answers: yes`. The `tracker-backup` section should say
`loaded: yes`, how many backups there are, and the last night's line.

To make a backup now instead of waiting for the night:

```bash
launchctl kickstart gui/$(id -u)/com.spirality.tracker-backup
```

### Restoring a backup

1. Stop the server, or launchd will restart it mid-restore:
   `launchctl bootout gui/$(id -u)/com.spirality.tracker`
2. Set the current database aside rather than deleting it:
   `mv ~/spirality-tracker/tracker.db ~/spirality-tracker/tracker.db.before-restore`
   and the same for its `-wal` and `-shm` files, if present.
3. Copy the backup in:
   `cp ~/spirality-tracker/backups/tracker-YYYY-MM-DD.db ~/spirality-tracker/tracker.db`
4. Start it again (this touches only the tracker, not the loop lanes):
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.spirality.tracker.plist`,
   then `./scripts/install_loop_runner.sh --status` to see `answers: yes`.

Anything written after that backup was made is not in it; the set-aside file
still has it.

## Switching a product over

The same steps for every product; only the values come from its project
config (`spirality.project.json` for Spirality). Each step says what a good
result looks like. Stop at the first one that does not look like that.

**Who runs it.** A hand-run session (Claude in a terminal, or Dane) on the
Mini, from the product's main checkout on `main`. **Never a loop session**:
a loop pass runs inside the lanes step 1 stops, and would cut itself off
mid-pass. The one step that is Dane's is the merge in step 6.

**Before the day.** A small pull request (the "switch PR") is open and green,
not merged. It changes the project config, and only that, plus the
"where tickets live" wording in `CLAUDE.md` and the skills:

```json
"tracker": "api",
"trackerUrl": "http://<the Mini's network name>.local:<trackerPort>",
"trackerApiUrl": "http://127.0.0.1:<trackerPort>",
"operatorUserId": "<the operator's tracker actor id>",
"machineUserId": "<loop-build's tracker actor id>"
```

`scutil --get LocalHostName` prints the Mini's network name (Spirality:
`mac-mini`, so `http://mac-mini.local:4180`); Dane's browser uses this
address, and the hand-over email links to it.

`trackerApiUrl` is the address the loops themselves call: the door, so
every runner and the relay. On the Mini it is the Mini's own address,
`127.0.0.1`, because Node on the Mini cannot look up the Mini's own
`.local` name (`getaddrinfo` answers "not known"; only `ping` and `curl`
find it). Spirality learned this the hard way: after its switch every loop
and relay pass failed with "fetch failed" until a `TRACKER_URL` value in
Doppler patched it. Left out, `trackerApiUrl` is `trackerUrl`.

The actor ids are the ones `npm run tracker:signins -- check` prints
(Spirality: the operator is actor 1, `loop-build` actor 2). With the
tracker, the operator id is who a hand-over is assigned to, and the machine
id is only used to refuse assigning a ticket to the machine.

The import (step 4) must run **before** the switch PR merges: it reads the
ClickUp seat ids the config holds until then.

### The steps

1. **Stop the loops.** First wait until no pass is in flight:
   `./scripts/install_loop_runner.sh --status` shows no lock held, and
   `npm run clickup -- queue` shows no ticket in `Building`. Then:

   ```bash
   ./scripts/install_loop_runner.sh --uninstall
   ./scripts/install_loop_runner.sh --status
   ```

   Good: every job says `loaded: no`. From here until step 7 nothing writes
   to ClickUp's Loop Queue, so what is imported is what the loops left.

2. **Start the tracker by hand**, in a second terminal tab, against the real
   database (it runs as a service from step 7 on):

   ```bash
   TRACKER_DB=<trackerDataDir>/tracker.db TRACKER_PORT=<trackerPort> TRACKER_HOST=<trackerHost> \
     node --disable-warning=ExperimentalWarning tracker/server.mjs
   ```

   Good: `tracker listening on http://...`. Leave it running.

3. **Make sure the sign-ins are whole:**

   ```bash
   npm run tracker:signins -- create --name <project name>
   ```

   Good: each seat `already signs in ... left alone`, and the operator's
   line says his ClickUp seat `now maps` or `already maps` to his actor. A
   database made before that mapping existed gets it here; without it, the
   import refuses to run rather than file his history under a second
   operator.

4. **Import the queue.** A dry run first, then the real one:

   ```bash
   npm run tracker:import -- --db <trackerDataDir>/tracker.db --dry-run
   npm run tracker:import -- --db <trackerDataDir>/tracker.db
   ```

   Good: `Import finished.`, nothing refused. A run that stops part way is
   safe to run again; it carries on.

5. **Check it is safe to switch:**

   ```bash
   npm run tracker:switch-check
   ```

   It writes nothing, anywhere. Good: every line `OK` and `Safe to switch.`,
   exit 0. `loops' address` fetches the tracker with Node, as the loops do
   (not `curl`, which finds names Node cannot); a `NOT OK` there names the
   address to put in `trackerApiUrl`. In particular `queues match` says
   every ticket is in both with the same status, so the import counts match
   ClickUp's. A
   `STATUS DIFFERS` line means a ticket moved after it was imported (the
   importer adds new tickets and comments on a re-run but does not refresh
   one it already has): move that ticket in the tracker to ClickUp's status,
   by hand, then check again. A `NOT YET IMPORTED` line under
   `dry-run import` means something reached ClickUp after the import (a
   comment, say, which leaves the statuses matching): run the real import
   again (step 4), then check again.

6. **Dane merges the switch PR.** His word, as for every merge. Then bring
   the checkout up to date: `git pull` on `main`.

7. **Start everything again**, now on the tracker. Stop the hand-started
   server first (Ctrl-C in its tab), then:

   ```bash
   ./scripts/install_loop_runner.sh
   ./scripts/install_loop_runner.sh --status
   ```

   Good: the lanes, the relay, the tracker and its backup all
   `loaded: yes`, and the tracker `answers: yes`.

8. **Check the loops see the same queue.** `npm run clickup --` now talks to
   the tracker:

   ```bash
   npm run clickup -- queue
   npm run clickup -- waiting
   ```

   Good: `queue` lists the same open tickets ClickUp's Loop Queue showed at
   step 1, with tracker ids (`SP-12`); `waiting` lists the same tickets as
   the page's "Waiting on you" at `trackerUrl`. After the next relay pass
   (ten minutes), its log (`<logDir>/<productSlug>-relay.log`) ends with a
   pass that read the tracker without errors.

### The week side by side

ClickUp's Loop Queue is left exactly as it was at step 1 and is not written
to: every loop, and Dane, works in the tracker. ClickUp is the record to
compare against if anything looks wrong. Making the list read-only, and
letting ClickUp go, is a later ticket.

### Switching back

The switch is one config change, so going back is too, done the same way:
stop the loops (step 1), a pull request that sets `tracker` back to
`"clickup"` and the ids back to the ClickUp seats, Dane's merge, start the
loops (step 7). Anything done in the tracker during the week stays in the
tracker and is not copied back to ClickUp; a ticket moved there is moved by
hand in ClickUp.

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
