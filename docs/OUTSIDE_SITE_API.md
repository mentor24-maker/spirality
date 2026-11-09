# Outside sites: the calls a site's server makes

An **outside site** is another project's web page that lets Dane's team use
the tracker without opening the tracker's own page: today, StarCaster's
Spirality page (its Spirality Tasks module, built in StarCaster's own queue).
A teammate Dane invites can finish joining, sign in, see a project's tasks,
file a request, comment and reset their password, all on that page.

**There is no open sign-up.** The only way in is still an admin's invite.
"Register" on a site's page means "finish joining from your invite email".

The browser never calls the tracker. The site's **server** makes every call
below and passes the answers on to its own page, so the tracker needs no
CORS and its session token never reaches the browser's script.

## Setting a site up (once, on the Mini)

1. Make the site's actor, a machine marked as a site, with the page its
   emailed links should open:

   ```bash
   TRACKER_DB=~/spirality-tracker/tracker.db \
     node tracker/admin.mjs create-actor --kind machine --name starcaster-page \
       --site-url https://<the site's address>/spirality
   ```

   The address must be `https://` (plain `http://` only for
   `http://localhost…`, for trying a site out). It is stored on the actor,
   never in code. The command prints the site's **token** alone on stdout,
   once; pipe it straight into the **site's own Doppler project**. It never
   goes in a repository, a log or the page's script.

2. The token is a machine's token: with it, a call reads what a loop reads.
   Keep it on the site's server. The site uses it for one thing only, the
   "Forgot password?" call (below); everything a person does goes with
   **that person's** session, so the tracker records them as the author.

## The rule for the link

An invite or reset link carries its token in the address
(`?link=<link token>`), and that token alone sets the account's password
for 7 days (invite) or 1 hour (reset). The tracker's own page guards it by
answering `Referrer-Policy: no-referrer`; the page at the site's address
must do the same, or the token leaks to every other server the page talks to
in their `Referer` logs:

- That page answers with the header `Referrer-Policy: no-referrer`.
- It loads **no** third-party script, font, image or analytics before the
  link is used (calls 2 and 3 below are done).
- Its script reads `?link=`, hands it to the site's own server, and at once
  removes it from the address bar with
  `history.replaceState(null, '', location.pathname)`, so it is not kept in
  history, bookmarks or a shared screenshot.
- The site's server never writes the link token to a log.

## The rule for the session

`POST /signin` answers a `Set-Cookie: tracker_session=<token>; HttpOnly;
SameSite=Strict; Path=/; Max-Age=2592000`. The site's server keeps that
value **on the server**: in its own httpOnly cookie, or in its own session
store keyed by one. It sends it back to the tracker on each call as
`Cookie: tracker_session=<token>`. It is **never** handed to the page's
script, never put in an address and never logged.

Every write sent with the session must say `content-type: application/json`
(the tracker refuses anything else with 415 `json-only`).

## The calls, in order

Each request below is JSON; each answer is JSON. A refusal answers
`{ error: <code>, message: <a plain sentence> }`; show the person the
`message`, which is written for them.

### 1. Invite (Dane, on the tracker's Users page)

An admin opens **Users**, types the email and picks **Send the link to:
<the site's name>**. The email's link opens:

```
https://<the site's address>/spirality?link=<link token>
```

(Behind the page: `POST /invites` with `{ email, site: <site actor id> }`;
a `site` that is not a site actor is 400 `not-a-site` and nothing is sent.
A site's token may not invite anyone: 403 `people-only`.)

### 2. What is this link for? `POST /account/link` (no token)

The site's page reads `?link=`, takes it out of the address bar
(`history.replaceState`, see "The rule for the link"), and its server asks
what it is for.

```
POST /account/link
{ "link": "<link token>" }

200 { "purpose": "invite", "email": "tess@example.com", "expiresAt": "2026-11-13T22:00:00.000Z" }
```

`purpose` is `invite` (ask for a name and a password), `reset` or `setup`
(a password only). Errors to show: 400 `unknown-link`, `used-link`,
`expired-link`.

### 3. Set the password: `POST /account/set-password` (no token)

```
POST /account/set-password
{ "link": "<link token>", "password": "<at least 12 characters>", "name": "Tess" }

200 { "purpose": "invite", "name": "Tess", "email": "tess@example.com" }
```

`name` only for an invite. Errors to show: 400 `weak-password`, `missing`,
`unknown-link`, `used-link`, `expired-link`. A link works once; a reset
link also signs the person out everywhere.

An invited person belongs to no project until an admin adds them on the
project's page (**Add Member**); until then, the project's calls answer 404.

### 4. Sign in: `POST /signin` (no token)

```
POST /signin
{ "email": "tess@example.com", "password": "<their password>" }

200 { "id": 7, "kind": "human", "name": "Tess" }
Set-Cookie: tracker_session=<session token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000
```

Errors to show: 401 `no-match` ("That email and password do not match.",
the same for an unknown email), 429 `locked` (5 failures in 15 minutes),
400 `missing`.

### 5. Who is signed in: `GET /me` (session)

```
GET /me
Cookie: tracker_session=<session token>

200 { "id": 7, "kind": "human", "name": "Tess" }
```

401 `unauthorized` on this or any call below means the session has ended
(signed out, reset, or 30 days passed): show the sign-in form again.

### 6. Their projects: `GET /projects` (session)

```
200 { "projects": [{ "slug": "spirality", "name": "Spirality", "prefix": "SP", "url": null, "logo": null, "owner": { "id": 1, "name": "Dane" }, "repo": "…", "open": 12 }], "default": "spirality" }
```

Only the projects the person is a member of (an admin sees all).

### 7. A project's tasks: `GET /projects/:slug/board` (session) — read by outside sites

The Spirality Tasks module draws its task list from this answer, using the
tracker's status order and names as they come. **This shape is pinned by a
test** (`tracker/server.test.mjs`, "GET /projects/:slug/board keeps the
shape outside sites read"), so a change to it fails `verify` instead of
breaking the site's page.

```
GET /projects/spirality/board

200 {
  "project": "spirality",
  "projectName": "Spirality",
  "columns": [
    { "status": "Requested", "tickets": [] },
    { "status": "Rework", "tickets": [] },
    { "status": "Queued", "tickets": [
      { "id": "SP-153", "name": "…", "priority": "urgent", "tags": ["starcaster-integration"],
        "assignee": null, "updatedAt": "2026-11-06T22:00:00.000Z",
        "pullRequest": null, "answerIn": false }
    ] },
    { "status": "Building", "tickets": [] },
    { "status": "In review", "tickets": [] },
    { "status": "Needs your input", "tickets": [] },
    { "status": "Ready to launch", "tickets": [] },
    { "status": "Live", "tickets": [] }
  ]
}
```

Always the eight columns, in that order; each column's tickets in queue
order. `assignee` is a name or null; `pullRequest` a URL or null.

`GET /projects/:slug/tickets` answers the same tickets as one flat list,
`{ project, tickets: [{ id, name, description, status, priority, tags, … }] }`,
with the status in small letters; `?status=queued` or `?open=true` narrow it.

Errors to show: 404 `unknown-project` (no such project, or not one of
theirs: the same words either way).

### 8. File a request: `POST /projects/:slug/tickets` (session)

```
POST /projects/spirality/tickets
{ "name": "What breaks and who feels it", "description": "In their own words.", "status": "requested" }

201 { "id": "SP-160", "project": "spirality", "number": 160, "name": "…", "description": "…", "status": "requested", "priority": null, "tags": [], "assignee": null, "loopNote": "", "createdAt": "…", "updatedAt": "…", "version": 1 }
```

A site files only `requested` tickets: the intake loop turns them into specs.
Errors to show: 400 (a missing name, a bad field).

### 9. A ticket and its comments: `GET /tickets/:id/thread` (session)

```
200 { "id": "SP-160", "name": "…", "status": "requested", …, "comments": [
  { "id": 1, "parent": null, "author": { "id": 7, "kind": "human", "name": "Tess" }, "machine": false, "body": "One more detail.", "createdAt": "…" }
] , … }
```

### 10. Comment: `POST /tickets/:id/comments` (session)

```
POST /tickets/SP-160/comments
{ "body": "One more detail." }

201 { "id": 1, "ticket": "SP-160", "parent": null, "author": 7, "body": "One more detail.", "createdAt": "…" }
```

`parent` (a comment id) makes it a reply. The author is always the person
signed in; a body naming another author is refused.

### 11. Forgot password: `POST /account/forgot` (the site's token)

```
POST /account/forgot
Authorization: Bearer <the site's token>
{ "email": "tess@example.com" }

200 { "sent": "If that email has an account, a link to set a new password is on its way. It works for 1 hour." }
```

Sent with the site's token, the reset email's link opens
`https://<the site's address>/spirality?link=<link token>`, and the site
finishes it with calls 2 and 3, under the same rule for the link
(`Referrer-Policy: no-referrer`, no third-party loads, `replaceState`). Without it (or with any other token) the
link opens the tracker's own page. The answer is the same either way, and
the same whether or not the email has an account: show it as it comes.

### 12. Sign out: `POST /signout` (session)

```
POST /signout
Cookie: tracker_session=<session token>
{}

200 { "signedOut": true }
```

Then drop the session the site kept.

## What a site never does

- Never makes an account: there is no call for it without an admin's invite.
- Never sends the tracker's session token or its own site token to the
  browser, puts either in an address, or writes either to a log.
- Never calls the tracker from the browser.
- Never lets a link token leave the page at the site's address: no
  `Referer` (the page sends `Referrer-Policy: no-referrer`), no third-party
  loads before the link is used, and the token taken out of the address bar.
