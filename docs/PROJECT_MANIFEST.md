# A project's manifest: `spirality.project.json`

Every project Spirality builds keeps one file at the root of its repository,
`spirality.project.json`: who the project is. This document is the format of
that file, written once. Spirality owns it (`docs/INTEGRATION.md`, "1. A
manifest"); a project fills it in.

The reader is `lib/projectConfig.mjs`. It finds the file by walking up from
the folder a command runs in, checks every field below, and stops the caller,
naming the field and the file, when:

- a required field is missing;
- a field is there that this document does not list (a typo never quietly
  becomes "use some other project's queue");
- a value has the wrong kind (an id that is not digits, an address with a
  path in it);
- `manifestVersion` is missing or is not the version below.

`node scripts/project_config.mjs githubRepo`, run in the project's
repository, prints one value and exits non-zero naming the field if anything
in the file is wrong.

## The version

The current version is **2**.

Every manifest says which version it is written to, as its first field:

```json
{
  "manifestVersion": 2,
  ...
}
```

The version goes up by one whenever a field is **added**, **removed** or
**given a new meaning**. A change that only rewords this document leaves it
alone. Raising it is one pull request that changes `MANIFEST_VERSION` in
`lib/projectConfig.mjs`, this document, and Spirality's own manifest; each
other project's manifest then gets its one-line change as a ticket in that
project's queue. Until it does, Spirality refuses to run that project's
lanes, and says which number it found and which it expects.

What each version added:

- **1** (SP-262, 2026-11-12): the format as first written.
- **2** (SP-264, 2026-11-12): `applicationChecks`. A version 1 manifest
  becomes version 2 by changing its first line alone: the new field is
  optional.

## What each entry below says

- **Kind**: what the value looks like.
  - *id*: digits, written as a number or a string (`"901418065068"` or
    `901418065068`); it always comes back as a string.
  - *text*: a non-empty string.
  - *slug*: a short lower-case name: letters, digits and dashes.
  - *list of text*: a JSON list of non-empty strings.
  - *address*: an `http://` or `https://` address with nothing after the
    host and port (no path, query or sign-in).
- **Required**: *yes* means the file is refused without it. *no* means it may
  be left out, and then has the default shown.
- **Overridden by**: an environment variable (from Doppler) that, when set,
  wins over the file. Most fields have none.
- **Example**: Spirality's own value, unless it says otherwise.
- **Leaving the manifest**: a field marked this way is a fact about the
  machine or about ClickUp, not about the project. `docs/INTEGRATION.md` says
  it is not the project's to know, and a later ticket moves it out; until
  then it stays, and works as described.

## The fields

### `manifestVersion`

The version of this format the file is written to (see "The version").

- **Kind**: a whole number, exactly the current version (`"1"` as a string is
  refused).
- **Required**: yes
- **Example**: `1`

### `workspaceId`

The ClickUp workspace every ClickUp request runs in. A project that never
used ClickUp writes `"0"`.

- **Kind**: id
- **Required**: yes
- **Overridden by**: `CLICKUP_WORKSPACE_ID`
- **Example**: `"0"` (StarCaster's, from its ClickUp days: `"90141423066"`)
- **Leaving the manifest**: a ClickUp-era id.

### `spaceId`

The ClickUp space that holds the project's lists. `"0"` when there is none.

- **Kind**: id
- **Required**: yes
- **Overridden by**: `CLICKUP_SPACE_ID`
- **Example**: `"0"`
- **Leaving the manifest**: a ClickUp-era id.

### `loopQueueListId`

The ClickUp Loop Queue list the loops drained. On the tracker, this value
stands for the tracker project; `"0"` is fine.

- **Kind**: id
- **Required**: yes
- **Overridden by**: `CLICKUP_LOOP_QUEUE_LIST`
- **Example**: `"0"`
- **Leaving the manifest**: a ClickUp-era id.

### `operatorUserId`

The operator's seat: every hand-off to the operator assigns it. On the
tracker, the operator's actor id.

- **Kind**: id
- **Required**: yes
- **Overridden by**: `CLICKUP_OPERATOR_ID`
- **Example**: `"1"`

### `machineUserId`

The machine's seat, never assigned a ticket. On the tracker, the project's
`loop-build` actor id.

- **Kind**: id
- **Required**: yes
- **Overridden by**: `CLICKUP_MACHINE_ID`
- **Example**: `"2"`

### `githubRepo`

The GitHub repository pull requests go to.

- **Kind**: text, written `owner/name`
- **Required**: yes
- **Example**: `"mentor24-maker/spirality"`

### `dopplerProject`

The Doppler project that holds the project's keys.

- **Kind**: text
- **Required**: yes
- **Example**: `"spirality"`

### `dopplerConfig`

The config inside that Doppler project the loops use.

- **Kind**: text
- **Required**: yes
- **Example**: `"dev"`

### `launchdPrefix`

The start of every launchd label (the name macOS gives a background job) the
lane installer makes for this project.

- **Kind**: text
- **Required**: yes
- **Example**: `"com.spirality"`

### `logDir`

The folder the lanes write their logs and locks to. A leading `~/` is the
home folder.

- **Kind**: text
- **Required**: yes
- **Example**: `"~/loop-logs"`

### `mergePhrases`

What the operator writes on a ticket to mean "merge this". A comment matches
when it is one of these as a whole, with both sides lower-cased, runs of
spaces made one, and emphasis and closing punctuation dropped, so casing and
punctuation here do not matter. Each must hold a letter or digit.

- **Kind**: list of text, at least one
- **Required**: yes
- **Example**: `["merge", "merge it", "ship it", "approve"]`

### `governancePaths`

Files and folders a loop may not change unattended, and no auto-merge lane may
carry, on top of the floor every project shares (`lib/autoMergeLane.js`). An
entry ending `/` is a folder; a bare name is that file, or that module and its
test, in any folder; any other path is one file.

- **Kind**: list of text (may be empty)
- **Required**: yes
- **Example**: `["CLAUDE.md", "docs/LOOP_ENGINEERING.md", "docs/DOCTRINE.md", ".claude/skills/", ".claude/settings.json", ".github/workflows/"]`

### `autoMergeLanes`

The lanes allowed to merge without the operator's word. Empty means none.
Which lanes, if any, is the operator's decision.

- **Kind**: list of text (may be empty)
- **Required**: yes
- **Example**: `[]`

### `operatorName`

What the loops call the operator in anything the operator reads.

- **Kind**: text
- **Required**: yes
- **Example**: `"Dane"`

### `projectSlug`

The project's short name: in log and lock file names, in the sender tag a
loop signs its posts with (`[CC-<slug>]`), and as the tracker project's slug.

- **Kind**: slug
- **Required**: yes
- **Example**: `"spirality"`

### `legacyMachinePrefixes`

Comment prefixes the project's loops used before the `[machine]` stamp
existed, still in its old ClickUp history, so the loops can tell their own old
comments from the operator's. A new project: `[]`.

- **Kind**: list of text (may be empty)
- **Required**: yes
- **Example**: `[]`

### `projectScripts`

The project's own scripts that Spirality's wiring tests read, as paths
relative to the repository root. The names it may hold are `door`,
`busRelayInstaller`, `buildSkill`, `reviewSkill`, `loopDoc`,
`automergeReachCheck`, `preflightRunner`, `repairRunner`, `busRelayRunner`,
`reconcileScript`, and `gates` (a folder); see `lib/projectScripts.js`.

- **Kind**: an object of name to path (may be `{}`)
- **Required**: yes
- **Example**: `{}`

### `tracker`

Which tracker the loops talk to: `"clickup"`, or `"api"`, the tracker's own
web API on the Mini. With `"api"`, `operatorUserId` and `machineUserId` are
the tracker's actor ids and `projectSlug` is its project slug; the loops'
tokens come from Doppler, never from this file. A new project: `"api"`.

- **Kind**: `"clickup"` or `"api"`
- **Required**: no
- **Default**: `"clickup"`
- **Example**: `"api"`

### `trackerPrefix`

The start of every ticket id in the tracker (`SP-12`): capital letters and
digits, beginning with a letter.

- **Kind**: text, capital letters and digits
- **Required**: no
- **Default**: none (`null`)
- **Example**: `"SP"`

### `trackerPort`

The port the tracker service listens on. Only the project whose lanes run the
tracker sets it; a project that uses Spirality's tracker leaves it out, so the
installer installs no second tracker.

- **Kind**: a port number, 1 to 65535
- **Required**: no
- **Default**: none: this project runs no tracker service
- **Example**: `4180`
- **Leaving the manifest**: a fact about the machine.

### `trackerHost`

The address the tracker service listens on: `"127.0.0.1"` (that machine only)
or `"0.0.0.0"` (every machine on the home network). Used only with
`trackerPort`.

- **Kind**: text
- **Required**: no
- **Default**: `"127.0.0.1"`
- **Example**: `"0.0.0.0"`
- **Leaving the manifest**: a fact about the machine.

### `trackerDataDir`

The folder that holds the tracker's database and its nightly backups. Needed
whenever `trackerPort` is set. A leading `~/` is the home folder.

- **Kind**: text
- **Required**: no (but needed with `trackerPort`)
- **Default**: none (`null`)
- **Example**: `"~/spirality-tracker"`
- **Leaving the manifest**: a fact about the machine.

### `trackerUrl`

The tracker's address for the operator's browser and the hand-over email.
Required when `tracker` is `"api"`.

- **Kind**: address
- **Required**: no (but needed when `tracker` is `"api"`)
- **Default**: none (`null`)
- **Overridden by**: `TRACKER_URL`
- **Example**: `"http://mac-mini.local:4180"`
- **Leaving the manifest**: a fact about the machine.

### `trackerApiUrl`

The address the loops themselves call. On the machine the tracker runs on,
its own `.local` name may not resolve for Node, so this is that machine's own
address.

- **Kind**: address
- **Required**: no
- **Default**: the same as `trackerUrl`
- **Overridden by**: `TRACKER_API_URL`
- **Example**: `"http://127.0.0.1:4180"`
- **Leaving the manifest**: a fact about the machine.

### `trackerPublicUrl`

The tracker's address on the internet, through Tailscale Funnel, for an
outside site's server to call (SP-152). Always https, on port 443, 8443 or
10000 (none written means 443). Only the project that runs the tracker sets
it. `scripts/install_tracker_funnel.sh` puts the route on.

- **Kind**: an https address on a Funnel port; `null` is the same as left out
- **Required**: no
- **Default**: none: the tracker is not published
- **Example**: `"https://mac-mini.tail7fc5c6.ts.net:8443"`
- **Leaving the manifest**: a fact about the machine.

### `trackerPageUrl`

The https name people outside the home network open the tracker's page by
(SP-164), through a small forwarding site made from `trackerPublicUrl`
(`docs/TRACKER_MVP.md`, "The page's own name"). Invite and reset emails link
there when it is set, else to `trackerUrl`. Set it only once the name answers
with the tracker's sign-in screen.

- **Kind**: an https address; `null` is the same as left out
- **Required**: no
- **Default**: none (`null`)
- **Example**: `"https://spirality.alphire.agency"`
- **Leaving the manifest**: a fact about the machine.

### `tailscaleLabel`

The launchd label of the job that keeps Tailscale running on the tracker's
machine. The Funnel script checks it is loaded and never changes it.

- **Kind**: text; `null` is the same as left out
- **Required**: no (but needed by the Funnel script)
- **Default**: none (`null`)
- **Example**: `"com.starcaster.tailscaled"`
- **Leaving the manifest**: a fact about the machine.

### `tailscaleSocket`

The socket Tailscale's background half listens on, on the tracker's machine
(it runs without root). A leading `~/` is the home folder.

- **Kind**: text; `null` is the same as left out
- **Required**: no (but needed by the Funnel script)
- **Default**: none (`null`)
- **Example**: `"~/.tailscale/tailscaled.sock"`
- **Leaving the manifest**: a fact about the machine.

### `busProject`

The tracker project that is this project's bus (SP-24): its standing "Team
chat" ticket takes the alarms and reports `npm run clickup -- bus-post`
sends, and `bus-read` reads them back. No loop claims from it.

- **Kind**: slug; `null` is the same as left out
- **Required**: no
- **Default**: none: the project has no bus
- **Example**: Spirality has none; StarCaster's is `"starcaster-bus"`

### `projectLanes`

Lanes of the project's own, run by `scripts/loop_runner.sh` beside the
built-in ones (`loop-build`, `loop-review`, `loop-intake`, `relay`), each
named like a skill: lower-case words joined by single dashes, none listed
twice. Each gets its own tracker sign-in, its token in Doppler as
`TRACKER_TOKEN_<LANE>` (dashes to underscores, capitals). A lane not listed
has no sign-in and its passes are refused. The names `operator`,
`loop-build`, `loop-review`, `loop-intake`, `relay`, `hand-run` and `name` are
taken.

- **Kind**: list of lane names
- **Required**: no
- **Default**: `[]`
- **Example**: `["loop-handoff"]` (Spirality has none)

### `preMergeCommand`

The project's own step in the relay's merge (SP-185): a command, the program
then each argument as its own string (no shell), run from the repository root
once every check says "merge" and before the pull request merges. It is told
`LOOP_PR_NUMBER`, `LOOP_PR_URL`, `LOOP_HEAD_SHA`, `LOOP_BASE_BRANCH` and
`LOOP_TICKET_ID`. Exit 0 merges; any other exit, or running past 10 minutes,
merges nothing (`docs/LOOP_CONTRACT.md`, "A project's own pre-merge step").

- **Kind**: list of text, the program first, at least one; `null` is the same
  as left out
- **Required**: no
- **Default**: none: no step
- **Example**: `["node", "scripts/apply_migrations.mjs"]` (Spirality has none)

### `applicationChecks`

The project's own health checks (SP-264, `docs/INTEGRATION.md`, "3.
Application checks"): checks that watch the application, not the pipeline.
Spirality runs the ones that are due (`npm run app-checks`) and posts what
changed to the project's bus. Each entry is an object:

| Field | Required | What it is |
|---|---|---|
| `name` | yes | a short slug (`site-import-watch`), unique within the list |
| `command` | yes | the shell command, one string, run from the folder holding this manifest |
| `everyMinutes` | yes | a whole number, 10 or more (the relay ticks every 10 minutes) |
| `alarm` | no, default `true` | `true`: a failure is posted starting `ALARM:` (texted); `false`: a plain post |
| `timeoutSeconds` | no, default `60` | a whole number from 1 to 300; past it the command is stopped |

The command exits 0 when all is well, and non-zero printing one line saying
what is wrong. It posts nothing and calls nothing of Spirality's; it is not
given the tracker's sign-in. Only the first line it prints is posted.

A wrong entry (a missing or unknown field, a name listed twice,
`everyMinutes` under 10) is refused, naming the entry and the field. A list
with any check in it needs `busProject`: without a bus, what the checks find
would have nowhere to post. It needs `"tracker": "api"` too: the bus is a
tracker project, so on a ClickUp project every post would be refused.

- **Kind**: a list of the objects above
- **Required**: no
- **Default**: `[]`
- **Example**: `[{ "name": "broken-links", "command": "node scripts/broken_links.mjs", "everyMinutes": 60, "alarm": false }]` (Spirality has none)

## Old names that still load (SP-130)

Until November 2026 two fields were called `productSlug` and
`productScripts`. A manifest that still uses them loads as if it said
`projectSlug` and `projectScripts`; one that gives a field under both names
with different values is refused, naming both. They are not fields of their
own, and they go away in a later ticket, once every project has moved over:

```diff
-  "productSlug": "normie",
+  "projectSlug": "normie",
-  "productScripts": {},
+  "projectScripts": {},
```

## Spirality's own manifest

[`spirality.project.json`](../spirality.project.json), at the root of this
repository, is a complete example.
