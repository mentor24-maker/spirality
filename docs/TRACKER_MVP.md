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
| **Lists** | One Loop Queue per project. Workspace and space ids exist only to find the list. | `spirality.project.json`, `lists` |
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

- **"Assigned to me"**, across every project: his one view of what waits on
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
| Check-then-write claims, `--if-status` on every move, one build loop per project | ClickUp cannot change a status only if it is still what we read (2026-08-22, two reviews racing) | A move names the status it expects and the store refuses atomically. Two passes can never both win. |
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

Five tables hold the work; two more hold people's sign-ins.

```
projects  slug, name, prefix, operator actor,  -- replaces workspace + space + list
          url, logo, owner (a person), repo (GitHub owner/name)
actors    id, kind (human|machine), name, token hash,
          email, password hash                   -- people only
tickets   id, project, name, description, status, priority, tags,
          assignee, loop_note, created_at, updated_at, version
comments  id, ticket, parent (for replies), author, body, created_at
events    id, ticket, actor, what changed, from, to, at   -- written by the store, never by callers
```

```
sessions       token hash, actor, created_at, expires_at   -- a person signed in, 30 days
account_links  token hash, purpose (setup|invite|reset), email, actor,
               made_by, created_at, expires_at, used_at   -- single-use emailed links
```

- **Tickets are never deleted, except an unstarted one.** A ticket in
  `Requested` or `Queued` can be deleted by `DELETE /tickets/:id`; one in any
  other status is refused. The status check and the delete are one
  transaction, so a loop claiming the ticket at that moment either wins (the
  delete is refused) or loses (the claim finds no ticket). A deleted ticket
  is gone, with its comments and events; an imported one keeps its
  `imported_ids` rows, so a re-run of the importer cannot file it again.
- **Comments are append-only.** Nothing edits or deletes one, so the trail
  the loop reads can never shift under it. A comment is deleted only with
  its ticket, by the call above.
- **`version`** goes up by one on every change to a ticket. A write may say
  "only if the version (or status) is still X", and is refused if not. This
  is the atomic claim.
- **`events`** is the history: every move, with who made it and when. It
  makes "every write is read back" cheap, and it is the audit trail ClickUp
  never gave us.
- Ticket ids are short and readable (`SP-42`), and a ticket's address is
  `<tracker>/t/SP-42`.
- A project's **owner** is a person (a `human` actor), separate from its
  **operator**, who the loops hand tickets to. Its **url** (web address) and
  **logo** (an image's web address) are http(s) addresses or empty. Its
  **repo** is its GitHub repository, `owner/name` or empty; a pasted
  `https://github.com/owner/name` is saved as `owner/name`. No loop reads it
  yet: the loops still take the repository from the project config. A
  database made before these four existed gains them, empty, on start-up.
- **People sign in with an email and a password** (invite only; Dane's
  decisions of 2026-11-01). The email is unique whatever its case and kept
  lower-case. A password is at least 12 characters and is stored only as a
  salted scrypt hash (scrypt: a deliberately slow scramble built into Node,
  so a stolen database file cannot be turned back into passwords quickly). A
  machine never holds an email, a password or a session; the loops keep
  their tokens.
- **A session** is one signed-in browser: it lasts 30 days, and signing out
  ends it. Only its token's hash is stored, like a loop's token.
- **An account link** is a single-use emailed link: `setup` gives an
  existing person (Dane's own actor, so his history stays his) an email and
  a password; `invite` makes a new person; `reset` sets a forgotten
  password and ends every session that person had. Setup and invite links
  last 7 days, a reset link 1 hour. A used, expired or unknown link is
  refused, each with its own reason. A database made before these existed
  gains the columns and tables, empty, on start-up; no existing row changes.
- **An attachment** is a file kept on a ticket (SP-140): its name, type,
  size, the file's bytes themselves, who added it and when, in the
  `attachments` table. Keeping the bytes inside the database means the
  nightly backup already holds them, with no second folder to copy. Each is
  1 byte to 10 MB. Its bytes are never edited. Its name can be changed and
  it can be removed on its own, from the Docs page (SP-177); each writes an
  `attachment` event in the ticket's history naming who did it (from the old
  name to the new one, or to nothing for a removal), so a removed file is
  still on record by name. A removal cannot be undone except from the
  nightly backup. It also goes with its ticket, when an unstarted ticket is
  deleted. A database made before this
  gains the table, empty, on start-up. The loops read them through the door
  (SP-142): `npm run clickup -- get` prints one `attachments:` line per file,
  and `npm run clickup -- attachments --task <id> --to <folder>` saves each
  one, checked against its size.
- **A context document** is a file kept on a project, not on one ticket
  (SP-176): a brief, notes, a reference file that belongs to the project as
  a whole. The same name, type, size, bytes, adder and time, the same 10 MB
  limit and refusals as an attachment, in the `project_docs` table, so the
  nightly backup (a copy of the whole database) holds them with no change to
  `tracker/backup.mjs`. It is never edited; it is removed one at a time, and
  a project that still holds any is not deleted (409 `has-docs`). The build
  loop does not read them automatically.
- **Roles and permissions** (SP-143): every person has one of five roles,
  **admin**, **editor**, **contributor**, **reviewer** and **viewer**, each
  with a plain-words description, and each role a set of permissions. The
  model is WaveCenter's (its `docs/DATA_MODEL.md`, "Roles and permissions");
  the tables are the tracker's own. `roles` holds the five; `permissions`
  holds what a role may be allowed to do, starting with `user.read`,
  `user.edit`, `ticket.read`, `ticket.create`, `ticket.edit` and
  `ticket.delete`, so a new permission is a new row; `role_permissions` says
  which role has which (admin all six; editor all but `user.edit`;
  contributor reads users and reads, adds and changes tickets; reviewer and
  viewer read); `user_roles` is each person's role, with the admin who set it
  and when. The first three are written from `ROLES` and `PERMISSIONS` in
  `tracker/store.mjs` on every start-up. A person with no `user_roles` row is
  a **contributor**; a machine has no role. While nobody is an admin (a
  database from before roles, or a new one whose first project has just been
  made), every person who is a project's operator is made admin, so nobody is
  locked out. A role changes only through `setRole`, which refuses anyone who
  is not an admin and a change that would leave the tracker with no admin,
  checked in the same transaction as the write. **The permissions are
  recorded, not yet enforced**: nobody is refused anything because of a role;
  a later ticket makes them count.
- **Project members** (SP-144): `project_members` holds one row per project
  and person, with who added them (`added_by`, empty when the tracker did it
  itself) and when, the shape of StarCaster's `app_project_memberships`
  (its `docs/SQL/projects_multitenancy_setup.sql`), without its per-project
  role. When the table is first made, every person becomes a member of every
  project, so nobody loses anything. A project's owner and operator, when a
  person, are always members: made so on every start-up, when the project is
  made (with whoever made it) and when a new owner is named, and
  `removeMember` refuses to take them off (`required-member`). A machine is
  never a member. Only an admin adds or removes a member (`addMember`,
  `removeMember`), checked in the same transaction as the write. Someone
  invited after this is a member of nothing until an admin adds them.
  **Membership is strict** (SP-145), as StarCaster's is: a person who is not
  an admin sees and works on only the projects they are a member of
  (`projectsVisibleTo`). The Projects and Tasks pages, Waiting on you,
  search, reporting, the Add Task box (and its "did you mean" guess), Copy
  to another project and each person's projects on the Users page list only
  those. Any other project, or a ticket on one, answers 404 with exactly the
  words a project or ticket that does not exist gets, plus
  `yourProjectsOnly: true`, so the answer never says it exists; the page
  shows a plain "You Are Not on This Project" instead. An admin sees every
  project, so Dane is never shut out of one, and every machine sign-in (each
  loop, `hand-run`) reads and writes exactly as before: a loop is never
  narrowed. Membership is the only permission enforced; roles are still
  recorded only.

### The API

Every call carries the caller's own token (`Authorization: Bearer`, every
loop) or a person's session cookie (the page, once signed in), except the
calls that sign in and out, ask for a reset email, or use an emailed link
(the link is their proof). A cookie never stands for a machine, and a
write made with the cookie must say `content-type: application/json`,
which a plain form on another site cannot send, so another site can never
write as the person signed in (415 `json-only`, nothing written). The
answers are JSON (structured text programs read).

| Call | Does |
|---|---|
| `GET /me` | who this token is |
| `GET /actors/:id` | an actor's id, kind and name (never a token), for showing who wrote a comment |
| `GET /projects/:slug/tickets?status=&open=` | the queue |
| `POST /projects/:slug/tickets` | file a ticket |
| `GET /tickets/:id` | one ticket with its comments, oldest first |
| `PATCH /tickets/:id` | change name, status, priority, tags, assignee, description or Loop note, with optional `ifStatus` / `ifVersion`; answers 409 ("conflict") and writes nothing if the ticket has moved. A person's token may assign the ticket only to its project's operator or to nobody: anyone else gets 400 `bad-assignee` and nothing is written |
| `DELETE /tickets/:id` | delete a ticket nobody has started (`Requested` or `Queued`) with its comments and events; answers 409 `not-deletable` with its status for any other, 404 for an unknown one; the server log names the ticket and the actor |
| `POST /tickets/:id/comments` | a comment, or a reply when `parent` is given |
| `GET /tickets/:id/events` | the history |
| `GET /waiting` | for Dane's page: tickets in the operator's two statuses across every project, by the loop's own `waiting` verdict for the caller, newest first |
| `GET /pipeline` | for Dane's page: the Pipeline Status pod (SP-168). `{ stages: [{ name, job, logged, running, lastStart, nextDue }] }` for Relay, Build, Review and Intake, read from the ends of this machine's loop logs (`<logDir>/<projectSlug>-<job>.log`, from the project config); times as ISO strings, never a line of log text. A stage with no log or no pass yet answers `logged: false`; 503 `no-pipeline` when the project config was not usable at start |
| `GET /tickets/:id/thread` | for Dane's page: the ticket with each comment's author named and machine comments marked, its project's operator by id and name, and the Change panel's choices: the store's priorities and the four statuses a person may pick (Requested, Rework, Queued, Live) |
| `GET /projects` | for Dane's page: every project with its slug, name, ticket prefix and open count, and the project the New request form starts on |
| `POST /projects` | for Dane's page: add a project (`{ name, slug, prefix, url?, logo?, owner?, repo? }`), answered with its details read back; **a person's token only**: a machine's gets 403 and nothing is written. A duplicate slug or prefix, a slug that is not small letters, digits and hyphens (or is `new`), an owner who is not a person, an address that is not http(s), or a repo that is not `owner/name` (or its github.com address) gets 400 |
| `PATCH /projects/:slug` | for Dane's page: change a project's name, web address, logo, owner or GitHub repository (`{ name?, url?, logo?, owner?, repo? }`), answered with its details read back; **a person's token only**: a machine's gets 403 and nothing is written. The slug and ticket prefix never change (every ticket's id and its project link are built from them): naming either gets 400 `not-changeable`; an owner who is not a person, an address that is not http(s) or a repo that is not `owner/name` gets 400; an unknown slug 404 |
| `DELETE /projects/:slug` | for Dane's page: delete a project that has no tickets; **a person's token only**: a machine's gets 403. One with tickets gets 409 `has-tickets` (`"SP has 48 tickets; a project with tickets cannot be deleted"`) and nothing is removed; the count and the delete are one transaction; the server log names the project and the actor |
| `GET /people` | for Dane's page: the tracker's people (humans only), for the owner picker and the Users page. A person's token gets `{ people: [{ id, name, email, role, projects: [{ slug, name }] }], invites: [{ id, email, invitedBy: { id, name }, createdAt, expiresAt }], sites: [{ id, name }], roles: [{ name, description, permissions }], permissions: [{ name, description }], canEditRoles }`, the invites being the open ones (unused, unexpired) `sites` the outside sites an invite's link may open on (docs/OUTSIDE_SITE_API.md), and `canEditRoles` true for an admin; a machine's gets ids and names only. Never a token or a hash |
| `PUT /people/:id/role` | for the Users page's role picker: `{ role }`, one of the five. **An admin's token only**: a machine's gets 403 `people-only`, a person who is not an admin 403 `not-admin`. A change that would leave no admin is 409 `last-admin`; an unknown role 400 `bad-role`; an id that is not a person 404 `unknown-person`. Answers `{ id, role }` read back; a refusal changes nothing |
| `POST /invites` | for the Users page: invite someone (`{ email, site? }`); **a person's token only**: a machine's gets 403 `people-only`, a site's too. With `site`, an outside site's actor id, the email's link opens `<site's page>?link=<token>` instead of the tracker's set-password page; a `site` that is not a site actor is 400 `not-a-site` and nothing is made or sent. An email a person holds is 409 `duplicate-email`, one with an open invite 409 `duplicate-invite`, no mail sender 503 `no-mail`; otherwise a 7-day `invite` link is made and emailed through Resend, naming who invited them. A send Resend refuses withdraws the link and answers 502 `not-sent`, so no open invite is left. Answered 201 with `{ sent }` and the Users page's lists read back; the log names the actor, never the email or the link |
| `DELETE /invites/:id` | for the Users page: cancel an open invite, so its link is refused as unknown; **a person's token only**. An id that is not an open invite is 404 `unknown-invite`; a used invite stays as the record |
| `GET /projects/:slug` | for Dane's page: one project's details, its operator and owner by name, its web address, logo and GitHub repository, its open count and a count per status, its `members: [{ id, name, addedAt, addedBy }]` (`addedBy` null when the tracker added them), and `canEditMembers`, true for an admin signed in as a person; 404 for an unknown slug |
| `POST /projects/:slug/members` | for a project's Add Member picker: `{ person }`, a person's actor id. **An admin's token only**: a machine's gets 403 `people-only`, a person who is not an admin 403 `not-admin`. Someone already a member is 409 `already-member`; an id that is not a person 404 `unknown-person`. Answers 201 `{ project, members }`, read back |
| `DELETE /projects/:slug/members/:id` | for a member's Remove button: the same 403s; the project's owner or operator is 409 `required-member`, with the reason; someone not a member 404 `not-member`. Answers `{ project, members }`, read back; a refusal changes nothing |
| `GET /projects/:slug/board` | for Dane's page, and **read by outside sites** (StarCaster's Spirality Tasks module, docs/OUTSIDE_SITE_API.md): `{ project, projectName, columns: [{ status, tickets: [{ id, name, priority, tags, assignee, updatedAt, pullRequest, answerIn }] }] }`, the eight statuses in the contract's order, each column's tickets in `queue` order. A test pins this shape; changing it breaks a page outside this repository |
| `POST /account/link` | **no token**: what an emailed link is for (`{ link }` → `{ purpose, email, expiresAt }`), for the set-password page; a used, expired or unknown link answers 400 `used-link`, `expired-link` or `unknown-link` |
| `POST /account/set-password` | **no token**: use an emailed link (`{ link, password, name? }`, a name only for an invite) → `{ purpose, name, email }`; refused with the store's code (`used-link`, `expired-link`, `unknown-link`, `weak-password`, `missing`) and nothing written. The link and the password travel only in the body, never in an address, so neither reaches the log |
| `POST /signin` | **no token**: `{ email, password }` → the person, and a session cookie (`tracker_session`, `HttpOnly`, `SameSite=Strict`, `Path=/`, 30 days). A wrong password and an unknown email get the same 401 `no-match`, "That email and password do not match." After 5 failures for one email in 15 minutes, that email is refused (429 `locked`) for 15 minutes, even with the right password; the count is kept in memory, so a restart forgets it, and setting a password through an emailed link clears it. **No `Secure` flag yet**: the tracker is plain http on the home network; the ticket that opens it to the internet must add it, with https |
| `POST /signout` | **no token**: ends the cookie's session and clears the cookie |
| `POST /account/forgot` | **no token**: `{ email }` → the same answer whether or not the email has an account; an account's email is sent a 1-hour `reset` link through Resend after the answer has gone back. Sent with an outside site's own token (`authorization: Bearer <site token>`), the link opens `<site's page>?link=<token>`; with any other token or none, the tracker's set-password page; the answer is the same either way. The log says whether it went, never the link or the email |
| `GET /documentation` | for the Docs page: every `.md` file in this repository's `docs/` folder and its subfolders, `{ files: [{ path, title }] }`, the folder's own files first. `GET /documentation/<path>` answers one, `{ path, title, text }`; a path outside `docs/` (`..`, absolute, a link out) or not a `.md` file is 404 and reads nothing |
| `GET /projects/:slug/attachments` | for the Docs page: every file on the project's tickets, newest first, `{ project, attachments: [{ id, ticket, ticketName, name, type, size, addedBy, addedByName, createdAt }] }`, never the bytes. A project the caller is not on is 404, the same as one that does not exist |
| `GET /commands` | for the Docs page's Commands section: `{ commands: [{ name, source, description, steps }] }`, Your commands (`commands/`) then Loop skills (`.claude/skills/`), each by name; `steps` is the `SKILL.md` text below its front matter. No other file is read |
| `GET /projects/:slug/docs` | the project's context documents, newest first, `{ project, docs: [{ id, project, name, type, size, addedBy, addedByName, createdAt }] }`, never the bytes |
| `POST /projects/:slug/docs` | upload one context document, sent exactly as a ticket's attachment (the raw file, `x-file-name`, `x-file-type`), with the same 10 MB limit and refusals. Answers 201 with the document as listed, read back byte for byte |
| `GET /projects/:slug/docs/:n` | one context document, byte for byte, always as a download (the same headers as an attachment's) |
| `DELETE /projects/:slug/docs/:n` | remove one context document, read back gone: `{ removed, name, project }`. One the project does not have is 404. Every `/docs` call to a project the caller is not on is 404, the same as one that does not exist |
| `POST /tickets/:id/attachments` | attach a file: the raw file as the body (`content-type: application/octet-stream`, which a form on another site cannot send, so the cookie may make this one write that is not JSON), its name percent-encoded in `x-file-name`, its type in `x-file-type`. Answers 201 with `{ id, ticket, name, type, size, addedBy, createdAt }`, read back byte for byte. Over 10 MB is 413 `too-large` ("That file is over 10 MB. Attach a smaller one; nothing was saved."); an empty file or no name is 400; nothing is stored. The JSON calls' 1 MB limit is unchanged |
| `GET /tickets/:id/attachments` | a ticket's files, oldest first, without their bytes (the ticket page reads the same list in `thread`) |
| `PATCH /tickets/:id/attachments/:n` | rename one file: `{ name }`, its name only, with the upload's name rules (an empty name, `.` or `..` is 400 and nothing changes). Answers the file as listed with `changed` (false when the name was already that). Writes an `attachment` event, read back |
| `DELETE /tickets/:id/attachments/:n` | remove one file, bytes and all: answers `{ removed, ticket, name }`, checked gone, with an `attachment` event (from its name to nothing). A file not on that ticket is 404 |
| `GET /tickets/:id/attachments/:n` | one file, byte for byte, always as a download (`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, a sandboxing `Content-Security-Policy`), so an uploaded HTML file can never run as the tracker's page |
| `POST /tickets/:id/clone` | for Dane's page: copy a ticket into another project (`{ project }`), as a new ticket in `Requested` there with one comment naming where it came from; the original does not change |

The store enforces only what keeps the data true: valid statuses, the
atomic guards, authorship from the token. The contract's rules (only `ask`
sets Dane's statuses, the card checks, the PASS gate) stay in the package
modules and the door, exactly where they are tested today. Moving them into
the server is a later, separate decision.

### Dane's page

Part of the MVP, not an add-on: without it Dane cannot see or answer
anything once ClickUp is gone. Desktop browser only. Three screens, nothing
more:

1. **Waiting on you**: tickets in his two statuses, across every project,
   newest first. This is the one view he uses today.
2. **A ticket**: the description, the comments (cards drawn with the red
   `NEEDED FROM DANE` banner, machine comments visibly marked as such), and a
   reply box. He answers and says "merge" here. Under Details, a person
   signed in gets a **Change this ticket** panel, open by default: priority,
   tags (chips with a remove button, and a box where Enter adds one),
   assignee (the project's operator or nobody, the only two the contract
   allows), status, name and description (an Edit button opens the stored
   markdown in a text box, with Save and Cancel). The status list offers
   only Requested, Rework, Queued and Live, plus the current status: `ask`
   alone sets Dane's two, and a loop claims and verifies Building and In
   review. The name is locked, saying why, once a pull request is recorded,
   since the pull request's title must match it. Each change is saved on its
   own with the ticket's `version` as `ifVersion`, says "Saving…" then
   "Saved", and the page is drawn again from the server, so what shows is
   what was stored. If a loop moved the ticket meanwhile, the save gets 409:
   the page says nothing was overwritten, shows the ticket as stored, and
   does not try again. Any other refusal shows the server's reason beside
   the field and keeps what was typed.
3. **A board** per project: read-only columns of the seven statuses.

The page is served by `tracker/server.mjs` at `/` (a ticket at `/t/<id>`)
from `tracker/web/`. `/projects` is a table of every project: choosing a
name selects it and opens its tasks, and the View icon in its Actions column
opens `/projects/<slug>`, that project's details (prefix, operator, open
count, a count per status) with links to its board and list. The table and
the details page show each project's logo, web address, GitHub repository (a link to it on GitHub) and owner. A person
signed in sees a **New project** button above the table: it opens
`/projects/new`, the Create Project form, which files the project and opens
its details page; a refused save shows the server's reason and keeps what
was typed. Each row also gives a person an **Edit** icon, opening
`/projects/<slug>/edit` (the same form filled in, with the slug and ticket
prefix shown but locked), and a **Delete** icon, which asks "Delete
<name>?" and then reads the table again; a project with tickets is refused
with the server's reason and stays. A loop's sign-in sees neither icon.
**Users** in the header opens `/users`: everyone with an account (name
and email), the open invites (email, who invited, when it expires) each
with a **Cancel** button, and an **Invite someone** form that emails a
7-day link. A refused invite (a taken email, a second invite, an email that
did not go out) shows the server's reason and makes nothing; after an
invite or a cancel the page reads the lists again and says it worked only
when they agree. A loop's sign-in sees the names alone. Each row shows the
person's **Role**; an admin gets a picker there instead, whose change is read
back before the page says it worked, and a refusal (the last admin stepping
down) shows the server's reason. Under the invites, **Roles and Permissions**
shows which role has which permission. The roles are recorded, not enforced:
every person signed in may still invite (Dane's decision).
**Docs** in the header, between Users and Settings, opens `/docs`. Under Spirality's own documentation (below),
**Context documents** (SP-176): the selected project's own files, newest
first, with name, type, size, who added it and when, a **Download** link
(always saved, never opened in the page) and a **Remove** button that asks
first, naming the file, and reads the list back to check it is gone. An
**Upload Document** button sends one file at a time (over 10 MB is refused
before it is sent); a failed upload or removal says so in a line. Then a
**Task Files** table of every file on the selected project's tasks (the
project picked on the Projects page, else the first), newest first, with
the file's name (which downloads it), the task's id and exact name (which
opens it), its type, size, who added it and when. A project with no files
says so in a line. It reads `GET /projects/:slug/attachments`, which answers
the list without the bytes, to members of the project only; downloads stay
with `GET /tickets/:id/attachments/:n`. Above the table, **Add File** puts a
file on any of the project's tasks (pick the task, pick the file, up to
10 MB) through the same upload call the New Task form uses. Each row has
**Rename**, which asks for the new name and changes the name only, and
**Remove**, which first asks "Remove <file> from <task id> <task name>?"
and, confirmed, deletes it (SP-177). Each change is read back from the
table's own list before the page says it worked; a refusal is said in a
line, with the tracker's own words. Someone not on the task's project gets
the same 404 as for a task that does not exist, and nothing changes.
At the top, above both, **Spirality Documentation** lists every Markdown file
in this repository's `docs/` folder and its subfolders by title (its first
`# ` heading, else its file name) with its path; one opens at
`/docs/spirality/<path>`, drawn the way a ticket's description is, with a
**Back to Docs** link. It reads `GET /documentation` (the list) and
`GET /documentation/<path>` (one file's text), which read only `.md` files
inside `docs/`: a path with `..`, an absolute path, a link out of the folder
or anything else is 404 and nothing is read. Read only; the files change
through pull requests.
Below the task files, **Commands** lists every slash command a session can be given
(SP-179): Dane's own, from `commands/<name>/SKILL.md` (marked Your command),
and the loop skills, from `.claude/skills/<name>/SKILL.md` (marked Loop
skill), each as `/<name>` with its description. A search box filters the list
as it is typed, by name or by what the command does, name matches first.
Clicking one opens `/docs/commands/<name>`: its steps formatted, and Back to
Docs. It reads `GET /commands`, signed in only, which reads nothing but a
`SKILL.md` directly inside a folder directly inside those two (no links, no
deeper files; `tracker/commands.mjs`). `commands/` is a copy: the originals
live in `~/.claude/skills/` on the MacBook, and `npm run commands:copy` run
there refreshes it (it copies only each `SKILL.md`, removes a copy whose
original is gone, and writes nothing when a file looks like it holds a key,
when a name is not plain, or when it finds no commands at all); the refreshed
copy goes in through a pull request.
A browser opening `/projects` or `/projects/<slug>` gets the page; the page's own
call to the same address gets the data. `/users` is the page alone; its data
is still `GET /people` (the onboarding scripts read it), and a browser opening
`/people`, the page's old address, is sent on to `/users`. `node tracker/demo.mjs` starts a throwaway tracker
with test data to try it.

A person signs in to the page with their email and password and stays
signed in for 30 days, through a cookie the page's own script cannot read;
no token is kept in the browser. "Forgot password?" asks for an email and
sends a 1-hour reset link to it if it has an account, saying the same
either way. The page shows a count of tickets waiting on him in the
browser tab's title, so a pinned tab tells him at a glance.

### How the loops switch over without a rewrite

The modules in `lib/` read ClickUp-shaped objects (`comment_text`,
`user.id`, `date`). Rather than change them, the door gets a seam:

1. **The door talks to a "tracker", not to ClickUp.** Two implementations:
   the current ClickUp one, and ours, which hands back objects of the same
   shape. The project config says which one a project uses. Every command,
   guard and test stays as it is. (This is the same move-don't-rewrite rule
   as Phase 1.)
2. **The machine stamp keeps being written** while both trackers exist, so
   the readers stay correct on either. It is retired in a later ticket, once
   no project reads ClickUp.
3. **An importer** copies a project's Loop Queue, tickets and comments, into
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
and phone notifications (the bus, StarCaster's alarm list, came later: see "The bus" below),
search, more than one person, per-client environments, live
updates instead of the relay's 10-minute poll, server-side contract rules.

## Running it

The tracker runs on the Mini as two launchd jobs (launchd is the Mac's own
service manager: it starts a job at login, restarts it if it stops, and
survives a reboot). `scripts/install_loop_runner.sh` installs them beside the
loop lanes, but only for a project whose project config names a
`trackerPort`; a project without one gets no tracker jobs.

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

**After a merge, the server restarts itself onto the new code** (SP-150). A
pull only replaces files on disk; a running server keeps the code it started
with. So every lane's sync of main (`scripts/run_relay.sh` and
`scripts/loop_runner.sh`, through `scripts/lib/tracker_restart.sh`) notes
where main was before it synced, ahead of the step that puts a checkout back
on main, since that step can move main too. When the sync moved main and the
change touches **a file the server loads**, it restarts the job with
`launchctl kickstart -k gui/$(id -u)/<launchdPrefix>.tracker`, waits up to 20
seconds for the server to answer on `trackerPort`, and writes one line to that
lane's log: `tracker restarted for <old>..<new>`, or a line in capitals
beginning `TRACKER RESTART` / `TRACKER NOT RESTARTED` saying what went wrong
(including when it could not tell where main was, or what the server loads).

"A file the server loads" is the whole `tracker/` folder, every module
`tracker/server.mjs` imports from outside it (in `lib/` and `scripts/`),
followed import by import by `scripts/lib/trackerFiles.mjs` so the list cannot
fall behind the code, plus `spirality.project.json` (read at startup),
`package.json` and `package-lock.json`. `node scripts/lib/trackerFiles.mjs`
prints the list. A test loads the real server and fails if it loads a file the
list misses. Files only the command-line tools load (such as
`scripts/tracker/clickupTracker.mjs`, behind `npm run clickup`) are not on it:
each command starts fresh and already runs the new code.

The loop lanes restart after `npm ci`, and the relay runs `npm ci` itself when
the pull changed the package files, so a merge that adds a dependency
restarts onto it. Only the lane whose sync brought the change in sees main
move, so the restart happens once, and its line is in that lane's log:
`grep -h "tracker restart" ~/loop-logs/<projectSlug>-*.log | tail -1`.
A pull that changes nothing the server loads restarts nothing, and a project
with no `trackerPort` (or a checkout with no `tracker/server.mjs`) never
restarts anything. The server is down for a few seconds during the restart.

Logs are in the configured log folder: `<projectSlug>-tracker.log` (one line
per request: method, address, answer, actor id; never a token) and
`<projectSlug>-tracker-backup.log` (one `backup OK` or `backup FAILED` line
per night).

**The public address** (SP-152). StarCaster's server runs on Vercel, outside
the home network, and calls the tracker at `trackerPublicUrl`
(`https://mac-mini.tail7fc5c6.ts.net:8443`). That address is Tailscale
Funnel: Tailscale, already running on the Mini for StarCaster, answers https
there and hands each request to the tracker on `127.0.0.1:<trackerPort>`. No
router port is opened and no other account is involved. Port 8443 keeps it
apart from StarCaster's own Funnel routes on 443.

Through the public address the tracker serves **its whole page as well as
its API** (SP-162): Dane chose on 2026-11-09 to give his team the same page
from the internet as on the Mini, limited by each person's role and
projects, so it is built only once. That puts the admin screens on the
internet too, behind the same sign-in. Signed out, the page shows only its
sign-in screen; every data call needs a token or a session, except the two
that start one, and both are limited:

- **Sign-in** locks an email for 15 minutes after 5 failures in 15 minutes,
  counted **per door**: five wrong passwords through the public address lock
  only the public address, so tries from the internet can never lock Dane
  out of the Mini's page (and the other way round). Old entries are dropped,
  so emails tried at random do not pile up in memory.
- **Forgot password** sends one account at most one reset email every 15
  minutes and 4 a day, and each door sends at most 20 an hour in all. A
  refused one answers the same "on its way" (the log says why), so a loop
  against the public address can neither flood an inbox nor use up the
  Resend account that also carries the hand-over emails. An email with no
  account sends nothing and counts against nothing.

The session cookie carries `Secure` and every answer carries
`Strict-Transport-Security` there; on the home network (`trackerUrl`, plain
http) neither, so the Mini's page keeps working. The tracker knows a request
came through Funnel by what Funnel adds (`X-Forwarded-Proto: https`, a
`Tailscale-Funnel-Request` header, the public name as `Host`); someone on
the home network who sends those by hand only gets the stricter answer.
Every address in the page is relative to the name it was served under, and
the session cookie names no `Domain`, so the page also works under another
https name that forwards to the public address.

`scripts/install_tracker_funnel.sh` puts the route on, checks it and takes it
off. It reads the address, the tracker's port, the launchd job that keeps
Tailscale running (`tailscaleLabel`) and Tailscale's socket
(`tailscaleSocket`) from the project config, and writes only the one port in
the address:

| Command | What it does |
|---|---|
| `scripts/install_tracker_funnel.sh` | Puts the route on. Refuses (exit 3) if the running tracker is on code from before the public address (it would be published with no `Secure` cookie and no `Strict-Transport-Security`) or if the port already carries another route. Reads every route back: ours must be there and every other route (StarCaster's 443) exactly as it was, or it says FAILED. |
| `scripts/install_tracker_funnel.sh --status` | Says whether Tailscale's job is loaded, whether the route is on, and what `/me` answers on the Mini and at the public address (401 = reached, not signed in). Exit 0 only when all of that is right. |
| `scripts/install_tracker_funnel.sh --off` | Takes the route off and reads it back; the other routes are left as they were. |

Putting the route on waits up to a minute for the public address to answer:
on a port Funnel has not served before, Tailscale fetches its certificate on
the first call. If it still has not answered, the script says so and exits 1
with the route on; run `--status` again a minute later.

`Strict-Transport-Security` covers the whole name, not one port: a browser
that has opened the public address once keeps to https for every port of
`mac-mini.tail7fc5c6.ts.net` for a year. That is harmless today, because
StarCaster's routes there are https too.

The route survives a reboot: `funnel --bg` is saved in Tailscale's own
state, so it comes back whenever Tailscale does. To check from outside, on a
phone on mobile data open `https://mac-mini.tail7fc5c6.ts.net:8443/me`; it
shows `{"error":"unauthorized",...}`. From a computer on the tailnet, 8443
is closed by the tailnet access rule (StarCaster's `docs/TAILSCALE_POLICY.md`),
which Funnel traffic does not pass through; use mobile data.

**The page's own name** (SP-164). People outside the home network open the
tracker at an https name of our own, `spirality.alphire.agency`, rather than
the Funnel address. A name cannot simply point at Funnel (its certificate is
for the `ts.net` name), so a tiny Vercel project takes the requests under the
new name and passes every one on, path and query as they are, to
`trackerPublicUrl`. Its whole content is one file,
`sites/tracker-page/vercel.json`, made from the project config by
`node scripts/tracker_page_site.mjs`; `npm run check:tracker-page` (part of
`verify`) fails when the file and `trackerPublicUrl` disagree, so it is never
edited by hand. Nothing else goes in that folder: Vercel would serve a file
there in place of the tracker's own answer at that path. The tracker does
everything else: sign-in, roles and projects work exactly as on the Mini,
and the cookie, which names no `Domain`, is kept by the browser for the name
it opened. Requests arrive through Funnel, so they get the public address's
`Secure` cookie, `Strict-Transport-Security` and per-door sign-in locks.

When `trackerPageUrl` is set in `spirality.project.json`, the invite and
reset emails link there instead of `trackerUrl` (the server reads it when it
starts). It stays unset until the name below answers with the sign-in
screen, so no email links to a name that does not yet lead here.

Moving the name. Today `spirality.alphire.agency` belongs to **StarCaster's**
Vercel project (its answers carry `x-site-handler: resolved`), whose
Spirality Tasks block stays for StarCaster's other sites. The move is
outward-facing, so it is done **after this merges, by a hand-run session,
with Dane's word**, never by a loop. Signing in to Vercel is a browser
login, so that step is Dane's.

1. Check the route is on: `scripts/install_tracker_funnel.sh --status`
   ends in exit 0.
2. Make the forwarding project (once): from `sites/tracker-page`, run
   `npx vercel link` and create a new project, `spirality-tracker-page`,
   then `npx vercel deploy --prod`. Open the `*.vercel.app` address it
   prints: it shows the tracker's sign-in screen. (Done 2026-11-10: the
   project is `spirality-tracker-page`, at
   `https://spirality-tracker-page.vercel.app`. `link` also writes `.vercel/`
   and a short-lived token in `.env.local` into the folder; git ignores both,
   the CLI does not upload them, and `.env.local` can be deleted.)
3. In StarCaster's Vercel project, Settings → Domains, **remove**
   `spirality.alphire.agency`. The DNS record (`CNAME` to
   `cname.vercel-dns.com`) stays as it is; only which project answers moves.
4. In `spirality-tracker-page`, Settings → Domains, **add**
   `spirality.alphire.agency`. Vercel issues its certificate in a minute or
   two.
5. Check: `https://spirality.alphire.agency/` shows the sign-in screen;
   signed in, `https://spirality.alphire.agency/list/spirality` shows the
   Board/List page, and opening another page (Projects, a ticket) stays
   signed in. `curl -sI https://spirality.alphire.agency/me` answers 401 and
   no longer carries `x-site-handler`.
6. Open a pull request adding
   `"trackerPageUrl": "https://spirality.alphire.agency"` to
   `spirality.project.json`; once merged and the tracker restarted, invite
   and reset emails link to the name.

**Undo:** remove the name from `spirality-tracker-page` and add it back to
StarCaster's project; nothing on the Mini changes. If the Funnel address
ever changes, change `trackerPublicUrl`, run
`node scripts/tracker_page_site.mjs`, and deploy the folder again.

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

**Each project can have its own alert address** (SP-113). The Edit project
page has an "Alert email" and an "Alert phone" box. A hand-over on a project
with an alert email goes to that address; on one without, to
`TRACKER_NOTIFY_TO` as before. The log line says which of the two it used,
never the address itself. Only a person's sign-in sees the two boxes' values;
a loop's never does, and the Projects table never shows them. The phone is
kept in international form (`+18015550123`) for the hand-over text below.
One catch: while the email still goes
from Resend's shared sender (`TRACKER_NOTIFY_FROM` unset), Resend delivers
only to the Resend account's own address, so a project's alert email that is
any other address is refused by Resend (the log says `NOT sent`) until a
sending domain of our own is set up there.

**The hand-over text** (SP-114; Dane chose iMessage sent from the Mini, over
an SMS service or a push app) goes beside the email, to the ticket's
project's alert phone, through the Messages app on the Mac the tracker runs
on. No service, no key: Messages sends it as the Apple ID it is signed into.

- **The same rules as the email.** One text per hand-over (the same
  `<ticket>@<version>` key), never two. The text keeps its own record, apart
  from the email's, so a failed text never stops or repeats the email and a
  failed email never stops or repeats the text. Each also has its own queue,
  so a text stuck waiting on Messages never holds up an email. A failed text
  never fails the move; it is logged as `hand-over text NOT sent`, with the
  reason, and tried again after a wait: one minute, then two, doubling up to
  half an hour, or at once when its own ticket next changes. (A stuck
  Messages costs up to 30 seconds a try, so it is not tried on every write.)
- **Its link opens on a phone.** The text links to the settings file's
  `trackerUrl` (`http://mac-mini.local:4180`), never the Mini's own
  `127.0.0.1` address that Doppler gives the loops, which would not open
  anywhere but the Mini.
- **What it says:** `Waiting on you: <id> <name>`, the status, the card's
  ask cut to about 300 characters, and the ticket's link.
- **How it is sent.** `osascript` runs a fixed AppleScript that takes the
  number and the text as arguments (`on run argv`); neither is ever pasted
  into the script, so nothing in a ticket name can become AppleScript. A send
  that takes longer than 30 seconds is stopped and counts as failed.
- **When it is off.** On a machine that is not a Mac or has no `osascript`,
  texts are off, said once when the server starts (`hand-over text: off.`).
  A project with no alert phone gets no text, said once in the log until it
  has one. The log names the ticket, never the number.
- **Proving it:** `npm run tracker:test-text -- --project <slug>` reads that
  project's alert phone from the running tracker (as the operator, through
  `TRACKER_TOKEN_OPERATOR` in Doppler: a loop's sign-in is never shown the
  phone) and sends one test text through the same sender. Exit 0 once
  Messages accepted it, 1 with the reason.

**Setting up texts on the Mini, once (Dane's hand-offs).**

1. **An Apple login:** open Messages on the Mini and sign into an Apple ID
   that can send iMessages. If it is the same Apple ID as the phone being
   texted, a text to your own number can arrive silently, as a note to
   yourself, with no alert. A separate Apple ID for the Mini avoids that
   (your decision).
2. **Two clicks on the Mini's own screen** (not over SSH: a box shown there
   cannot be answered remotely, which is why a read of Messages over SSH on
   2026-11-04 timed out with `AppleEvent timed out (-1712)`). macOS asks each
   program separately before it may drive Messages:
   - Running `npm run tracker:test-text` in Terminal on the Mini asks
     **"“Terminal” wants access to control “Messages”"**. Click **Allow**.
   - The tracker server is a different program: launchd starts it as
     `node` (Homebrew's, `/opt/homebrew/bin/node`). Its first real hand-over
     asks **"“node” wants access to control “Messages”"**. Click **Allow**.
     Until then that send waits 30 seconds, is logged `NOT sent ... did not
     answer within 30 seconds`, and is tried again a minute later (the
     emails go on regardless).
   Homebrew's node is not signed by a developer, so macOS knows it by its
   exact build: after `brew upgrade node` the box can come back once.
   A click of **Don't Allow** is undone in System Settings → Privacy &
   Security → Automation, under `node` (or Terminal), by turning Messages on.

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

**A project's own lane.** A project that runs a lane of its own beside
these (WaveCenter's hand-off lane, say) names it in its project config's
`projectLanes` (`"projectLanes": ["loop-handoff"]`). Each name there is one
more machine seat, its secret built the same way the runner builds it
(`loop-handoff` → `TRACKER_TOKEN_LOOP_HANDOFF`): `tracker:signins create`
makes its actor and stores its token, `check` proves it, `npm run doctor`
lists it, and the door accepts it. A lane the config does not name has no
seat, and the door refuses its passes, saying to name it in
`projectLanes`. A name that is already a built-in seat (`loop-build`,
`relay`, `hand-run`, ...), or `name` (its secret would be
`TRACKER_TOKEN_NAME`, the runner's own variable), stops the config from
loading, naming the entry, so two lanes never share a token and one bad
entry never locks the built-in lanes out (`RESERVED_LANE_NAMES` in
`lib/projectConfig.mjs`). No project's lane names are written in
Spirality's code.

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

**A person's password, by email.** A person sets a password from an emailed
link: `<trackerUrl>/set-password?link=<token>`, a page that needs no
sign-in. It shows the email the link is for (read-only), asks for the
password twice (and a name, for an invite), and once saved says "Password
set. Sign in at <tracker address>." The same link a second time, or an
expired or unknown one, says which in plain words and saves nothing.
Once set, the password signs in on the page (`POST /signin` above); a
forgotten one is reset from the page's "Forgot password?".

Dane's first link comes from a command a session runs **on the Mini**, so
his existing actor, and all his history, becomes his account:

```bash
npm run tracker:account -- setup-link --actor <id> --email <address>
```

It refuses a machine actor, an email another person holds, a missing
`RESEND_API_KEY`, or a config file with no `trackerUrl`, each with its
reason, and sends nothing. Otherwise it makes a 7-day `setup` link, emails it
through Resend (the hand-over email's sender; `TRACKER_NOTIFY_FROM` if set),
titled "Set your <project name> password", and prints one line:

```
sent to dane@example.com, good for 7 days
```

A send Resend refuses prints `NOT sent to <address>: <Resend's answer>`
and withdraws the link, so no usable link is left behind. The link's
address is the config **file's** `trackerUrl`, never Doppler's
same-machine `TRACKER_URL` override, which would not open from another
computer. Neither the link's token nor a password is ever printed or logged.
Resend's shared sender delivers only to the Resend account's own address
until a domain is set up there, so for now this reaches Dane and nobody
else. `node tracker/demo.mjs` prints a throwaway email and password to sign
in with and a set-password link for the test operator, for trying the page;
its "Forgot password?" prints the reset email instead of sending it, and
an invite from its Users page prints the invite email and then
`Invite link for <email>: <link>`.

**Inviting someone new.** A person signed in invites them from the Users
page (`POST /invites` above). The email, titled "<inviter> invited you to
the <project name> tracker", carries a 7-day `invite` link to the same
set-password page, which asks for their name as well as a password; once
saved they sign in like anyone else. Nobody can register without an
invite. Until Resend has a domain set up, its shared sender delivers only
to the Resend account's own address, so an invite to anyone else is refused
by Resend: the page says the email did not go out, and no invite is left.

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

## Switching a project over

The same steps for every project; only the values come from its project
config (`spirality.project.json` for Spirality). Each step says what a good
result looks like. Stop at the first one that does not look like that.

**Who runs it.** A hand-run session (Claude in a terminal, or Dane) on the
Mini, from the project's main checkout on `main`. **Never a loop session**:
a loop pass runs inside the lanes step 1 stops, and would cut itself off
mid-pass. The one step that is Dane's is the merge in step 6.

**With the setup wizard.** A project that runs its own older copy of the
loop (WaveCenter, StarCaster) is moved by `npm run onboard -- --project
<slug>` instead of by hand (SP-159): its answers name its Loop Queue list
(asked in the Terminal, or on the setup page's answers form),
and the wizard runs steps 1, 4 and 5 below itself, as its `stop`,
`snapshot`, `import` and `switch-check` steps, after the sign-ins (step 3)
and before its setup pull request opens. That pull request is the switch
PR, and Dane's merge phrase on its setup ticket is step 6. Step 7 comes
before the merge there, as for every project the wizard sets up: its lanes
step installs the new lanes from the setup branch, already on the tracker,
once the import and the check are done. Step 2 is not needed: the tracker
already runs as a service on the Mini. How it finds the lanes and which settings the
scripts read: [ONBOARDING_A_PROJECT.md, "A project already on
ClickUp"](ONBOARDING_A_PROJECT.md#a-project-already-on-clickup-wavecenter-starcaster).

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

4. **Save a full copy of ClickUp, then import the queue.** The importer
   carries tickets, comments and replies across, not attachments (Dane's
   screenshots), time in each status, custom fields or the raw records. So
   first save everything, once, on the Mini, a dry run first:

   ```bash
   npm run tracker:snapshot -- --dry-run
   npm run tracker:snapshot
   ```

   It saves the config's Loop Queue list, plus any `--list <id>` given (one
   per extra list worth keeping). The only extra list worth keeping is
   StarCaster's alarm list (the bus, SP-24). StarCaster's Dev Backlog and
   its client lists (Marinoff & Associates, Delray Beach Tennis Center) are
   neither saved nor imported: Dane, 2026-11-08, *"StarCaster's other lists
   can all go away."* Nothing in ClickUp is deleted; ClickUp stays as the
   archive. A project whose config already names no
   ClickUp list (`loopQueueListId` all zeros, as Spirality's has been since
   its list became a read-only archive) saves only the `--list` ids, and
   refuses with a plain reason when none is given:
   `npm run tracker:snapshot -- --dry-run --list 901418065068`. The copy goes
   into
   `<trackerDataDir>/clickup-archive/<projectSlug>-<date>/` and packs it into
   `<trackerDataDir>/backups/clickup-archive-<projectSlug>-<date>.tar.gz`,
   which the nightly backup never prunes. It only reads ClickUp. Good: every
   line under `Compared with ClickUp:` says `OK`, and `Snapshot saved:`.
   A `DIFFERS` line (exit 3) names a count that does not match what ClickUp
   reports; a failed read or download stops it with exit 1 and leaves no
   snapshot, and running it again starts a fresh, complete copy. It takes a
   while (several requests a ticket, within ClickUp's per-minute limit).

   Then the import, a dry run first, then the real one:

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
   (ten minutes), its log (`<logDir>/<projectSlug>-relay.log`) ends with a
   pass that read the tracker without errors.

### The week side by side

ClickUp's Loop Queue is left exactly as it was at step 1 and is not written
to: every loop, and Dane, works in the tracker. ClickUp is the record to
compare against if anything looks wrong. Making the list read-only, and
letting ClickUp go, comes after the week (below).

### After the week

When the operator says the week went well (Spirality: Dane's go on
2026-11-08, on SP-22), the ClickUp list becomes a read-only archive. One
pull request sets the project config's three ClickUp ids to `"0"`:

```json
"workspaceId": "0",
"spaceId": "0",
"loopQueueListId": "0",
```

With `tracker` `"api"` and no ClickUp list, nothing in the project reads
ClickUp: the door talks only to the tracker, `npm run doctor` stops asking
for `CLICKUP_API_TOKEN`, and `tracker:import` and `tracker:switch-check`
refuse at once, saying the project names no ClickUp list. The list itself is
not deleted and nothing writes to it. Spirality's archive is list
`901418065068` in space `90146476540`, workspace `90141423066`; write the
old ids down here for each project, because the config no longer holds them.

**Old ClickUp links.** Pull requests, comments and `Waits on:` lines written
before the switch name ClickUp ids (`86bctjbc3`, or
`https://app.clickup.com/t/86bctjbc3`). The importer recorded every one it
copied in its id map (`imported_ids` in the tracker database), and one
read-only command reads it:

```bash
npm run tracker:old-id -- 86bctjbc3 https://app.clickup.com/t/86bcudhyj
# 86bctjbc3	SP-21	http://mac-mini.local:4180/t/SP-21
# 86bcudhyj	SP-31	http://mac-mini.local:4180/t/SP-31
```

It opens the database read-only (`TRACKER_DB`, else the config's
`trackerDataDir`), never talks to ClickUp, and prints `not imported` for an
id the importer never saw. Exit 0 every id found, 3 some were not, 1 the map
could not be read.

### Switching back

The switch is one config change, so going back is too, done the same way:
stop the loops (step 1), a pull request that sets `tracker` back to
`"clickup"` and the ids back to the ClickUp seats (after the week, the
ClickUp list ids too, from "After the week"), Dane's merge, start the
loops (step 7). Anything done in the tracker during the week stays in the
tracker and is not copied back to ClickUp; a ticket moved there is moved by
hand in ClickUp.

## Tickets as data (StarCaster's scheduled checks)

Seven of StarCaster's scheduled checks (throughput, stale-ready,
stale-answer, pipeline-pulse, sql:unapplied, broken-links and the
heartbeat's roll call) and its review-gate workflow read the Loop Queue
straight from ClickUp's API. After the switch nothing writes that list, so
they would report on nothing. Their one way in is the door (SP-205):

```bash
npm run clickup -- tickets --json                          # every open ticket, as JSON
npm run clickup -- tickets --json --include-closed         # Live tickets too
npm run clickup -- tickets --json --comments               # each ticket's top-level comments too
npm run clickup -- tickets --json --project starcaster-bus --include-closed   # another project the sign-in can see
```

It prints one JSON list, one object per ticket, in filing order:

| Field | What it holds |
|---|---|
| `id`, `name` | `SP-12`, the ticket's name |
| `status` | as `queue` prints it: `queued`, `in review`, `needs your input`, ... |
| `priority` | `urgent`, `high`, `normal`, `low`, or `null` |
| `tags` | a list of tag names |
| `created`, `updated` | ISO times, in UTC |
| `statusSince` | when it entered its current status (ISO, UTC): its newest status move in the ticket's history, or its filing when it never moved |
| `comments` | with `--comments` only: `{ id, author: { id, name }, by, at, text }` per top-level comment, oldest first; `by` is `operator` when the author is the project's operator seat, else `machine`; `text` exactly as stored, machine stamp included |

It writes nothing. Every read has to come back: when the list, any ticket's
history or any ticket's comments cannot be read, it prints nothing on
standard output and exits 1 naming each read that failed, so a check never
counts half the queue as the whole of it. The shape lives in
`lib/ticketsJson.js`, with its tests. Moving StarCaster's checks onto it is
StarCaster's own pull request.

## The bus (StarCaster's alarms)

StarCaster raises its alarms on **the bus**: a ClickUp chat channel (the
"party line"), which ClickUp refuses on the free plan, so every post lands on
a standing **Team chat** ticket instead, plus a second ClickUp list, **Agent
Response**, where the steward asks Dane things and the relay watches for his
replies. Spirality has no bus; StarCaster cannot move to the tracker without
one (SP-24).

The tracker's bus is **a project of its own**, named in the project config
as `busProject` (for example `starcaster-bus`). It holds the same
standing "Team chat" ticket, found by its name (the oldest wins, so two
machines that both created one still agree), in Live, and any ticket the
steward files for Dane. No loop claims from it: the build and review lanes
read `projectSlug` only. Each comment carries its author's own actor, so
"only Dane's words" is read off the comment, not guessed from a stamp.

```bash
echo "the heartbeat stopped at 09:10" | npm run clickup -- bus-post --body-file -   # one comment, read back
npm run clickup -- bus-read --operator --since 2026-11-09T16:00:00Z                  # Dane's words since then
```

`bus-post` creates the Team chat ticket the first time, and exits 1 saying
so on any write it could not read back; there is no plan limit to fall back
from. Each post opens with `**From <machine>** · <time>`, the time in
Mountain time, because that header is what Dane reads on the page.
`bus-read` prints one tab-separated line per comment, oldest first, for a
script to read: time (ISO, in UTC, so it can go straight back in as
`--since`), ticket, `operator` or `machine`, author, first line. A ticket
whose comments cannot be read is named on its own line and the read carries
on with the rest, then exits 1, so one bad ticket never hides Dane's stop
word on Team chat. It reads top-level comments only: the tracker's comment
list leaves threaded replies out, and the page cannot post a reply today, so
nothing is missed yet; a reply feature on the page would need `bus-read`
taught to follow it.

A steward question is two commands: `task --list <busProject>` files it,
and it lands in Queued, which is not on Dane's Waiting on You list; then
`ask --task <id> --status "Needs your input"` with the operator card is
what puts it in front of him. Setting it up
for a project: the setup wizard does it when its answers say the project
has a bus (SP-204, `hasBus`): its `bus` step makes the tracker project
`<slug>-bus` (`npm run tracker:bus`), checks every loop of the project sees
it, and the settings file it writes names it as `busProject`
([ONBOARDING_A_PROJECT.md](ONBOARDING_A_PROJECT.md#a-project-with-a-bus-starcaster)).

Every way StarCaster uses the bus today, and its tracker equivalent (the same
table is `BUS_USES` in `lib/trackerBus.js`, and a test holds the two
together):

| StarCaster today | In the tracker |
|---|---|
| Alarms and reports posted to the party line (`postBusMessage`, the `chat` command): heartbeat, throughput, report_job_failure, reconcile, stale_answer, stale_ready, checkout_currency, ai_keys_check, site_import_watch, unapplied_sql_watch, pulse_publish, weekly_report, repair | `npm run clickup -- bus-post --body-file -`: one comment on the bus project's "Team chat" ticket, read back |
| Direct chat posts that skip `postBusMessage`: the pause switch's `announce` (pipeline.mjs), the review gate's `announceWaiver`, the reconciler's `postBus` | `bus-post`, the same one command |
| The relay's own notices (`postToBus` / `postOrSaveToBus`): merged, merge refused or deferred, stalled hand-off, auto-merge latched off, lane armed, "<operator> replied on ..." | The relay posts them itself, through the same read-back post as `bus-post`, when the project names a `busProject` (SP-207): one line for each merge it makes, each refusal and each conflict hand-off the first time it is written on the ticket (a quiet pass posts nothing), and the lanes' own notices (SP-202). A post that does not land is an UNCHECKED line and the pass exits 1; the merge is never undone or retried for it. A conflict hand-off still stuck a day later (or at once, with nothing filed to fix it) is said again, at most once a day: StarCaster's stall rule, without its "failed N times" alarm, because this relay's markers count reminders, not tries. Not carried over: the "replied on" relay, because the steward reads the operator's replies with `bus-read --operator` |
| The fallback when the party line refuses (`saveUndeliveredAlarm`): a comment on the "Team chat" ticket in the Loop Queue, created if missing, oldest wins | `bus-post` IS that ticket, in the bus project: there is no plan limit to fall back from, and a refused write exits 1 and says so |
| A relay receipt on the ticket a message was about (`deliverToBus` with a hand-back target) | `npm run clickup -- comment --task <id>`, unchanged |
| The steward filing a question for the operator as a ticket in the Agent Response list | Two commands, both needed: `npm run clickup -- task --list <busProject>` files it (it lands in Queued, which is NOT on the operator's Waiting on You list), then `ask --task <id> --status "Needs your input"` with the operator card puts it there |
| Reading the party line for the operator's stop and resume words (`readBusSwitchSignals`) | `bus-read --operator`: only comments whose author is the operator's own actor, no machine-stamp guess |
| The relay watching Agent Response tickets ("pending response", "responding") for the operator's comments | `bus-read --operator --since <time>`, across every ticket in the bus project |
| `waiting` sweeping the Agent Response list for "what actually needs me?" | The page's Waiting on You list, which reads every project the operator is on, the bus project included, but shows only tickets in the operator's statuses: a steward question shows there once it has been through `ask`, never straight after `task` |
| The operator seeing a new post: the "Team chat" ticket puts itself in their ClickUp "Assigned to me" list | An alarm (a post whose message starts with `ALARM:`) is texted to the bus project's alert phone; every post, alarm or not, counts in the "New on the Bus" number in the page's header until the operator opens "Team chat" (SP-163, the operator's choice D) |

**How loud a post is** (SP-163; Dane chose D on 2026-11-09: "a text for
alarms only, plus the page count for everything else"):

- **An alarm is texted.** A post whose message (below the `**From …**`
  line) starts with `ALARM:` is sent as an iMessage from the Mini to the
  bus project's **alert phone**, the same channel as the hand-over text,
  without the `[machine]` stamp line the door adds to every loop comment. A
  failed text is tried again after a minute, doubling up to half an hour, on
  a timer of its own: alarms fire when the loops are quiet, so it never waits
  for the next write. A bus project with no alert phone gets no text, said
  once in the tracker's log; set one on its Edit project page. No email: Dane
  did not choose one.
- **Every post is counted.** The page's header shows how many posts on
  Team chat tickets Dane has not seen ("3 New on the Bus"), linking to the
  ticket. Opening the ticket marks them seen, for him only: a seen mark is
  per person, kept by the tracker, so it is the same on his phone and his
  desk. His own comments never count.

```bash
echo "ALARM: the heartbeat stopped at 09:10" | npm run clickup -- bus-post --body-file -   # texted
echo "weekly report: 12 merged" | npm run clickup -- bus-post --body-file -               # counted only
```

Switching StarCaster's scripts over to these commands is the next ticket.

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
   then the projects.

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
