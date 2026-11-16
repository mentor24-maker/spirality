# UI doctrine: how the tracker page looks and reads

Alphire's projects share one look. StarCaster and Spirality's tracker page are
two of them, and a person moving between them should not have to learn two sets
of buttons. So the tracker follows the conventions StarCaster established for
its admin screens, with the values below, and Spirality's own rules (capital
letters, section 1) apply to both. Dane, 2026-11-15 (SP-318): *"I think it
makes sense to maintain style continuity between these two Alphire [projects], so
I think we should adopt all the style conventions established for Starcaster in
Spirality."*

Any change that adds or changes words or looks on the tracker page follows this
file. Rules about how the loop behaves are in [DOCTRINE.md](DOCTRINE.md).

**Where the rules come from.** StarCaster's admin-screen rules are in its
`docs/UI_RULES.md` (the master list, with its rule ids: L, D, W, C, T, R, S),
`docs/MODULE_UI_DOCTRINE.md` §2 and §3, the tokens in `src/css/_variables.css`,
and its `docs/DOCTRINE.md` §2, §5.31 and §5.35. Each rule below names its
StarCaster id, so a reader can find the incident behind it there. Rules about
StarCaster's Builder and its tenants' published pages are not adopted (section
11).

**The tracker does not follow all of this yet.** Section 12 says where it
stands, and which ticket brings each part into line. Until a part lands, new
work follows this file, and does not copy the page's older patterns.

**A change to a shared rule is made in both projects.** If a rule here changes,
StarCaster's copy changes in a pull request of its own, on its own ticket, and
the other way round. One look means one set of rules.

---

## 1. Capital letters on the page

Dane chose this on SP-138, "Make formatting consistent. Establish style
conventions doc" (2026-11-05): **Title Case** for the words that name a thing
you click or a part of the page. On 2026-11-15 (SP-318) he extended it to form
field labels, in both projects. `npm run verify` checks the rule
(`tracker/style.test.mjs`), so a label that breaks it fails the pull request.

### 1.1 What is in Title Case

- **Buttons**, including the words a button changes to for a moment
  ("Copied", "Not Copied"): "Add Project", "Post Reply", "Save Password",
  "Send Invite", "Sign Out".
- **Links drawn as buttons** (`<a class="button">`): "Set Up a Project".
- **The tooltip of an icon button or icon link**, which is its name for
  screen readers too: "View Project", "Delete Ticket", "Open Pull Request on
  GitHub".
- **Headings** (`<h1>` to `<h6>`): "Waiting on You", "Tickets by Status",
  "Copy to Another Project", "Some Answers Are Missing".
- **Toggles** that open a panel (`<summary>`): "Add Task", "Change This
  Ticket", "Details".
- **Table column headings** (`<th>`), including the Reporting page's ranges:
  "Last Change", "Ticket Prefix", "Assigned To", "Last 7 Days".
- **Tabs and view switches**: "Board", "List", "Console", the Settings tabs.
- **Form field labels**, the words that name a box, a list or a switch: "Reply
  as Dane", "Invite Someone", "Ticket Prefix". (SP-318; until then they were
  written as sentences. The check does not read them yet: section 12.)
- **The tab title and the trail at the top of the page**, which repeat the
  page's heading: "Set Up a Project · Tracker".

### 1.2 What stays as it is written

- **Sentences**: help text, notes under a button, error messages, the text
  shown inside an empty box (a placeholder), the "nobody" and "none"
  placeholders. They are sentences, so they take sentence case.
- **Plain links inside text** ("Back to Projects", "Fill in the answers").
- **The eight status names**: `Requested`, `Rework`, `Queued`, `Building`,
  `In review`, `Needs your input`, `Ready to launch`, `Live`. The loops read
  and write them exactly as `docs/LOOP_CONTRACT.md` spells them, so the page
  shows them that way too, even where they sit in a heading.
- **Names**: a project's or a person's name, a ticket's title, GitHub, SP-12.
- **Emails and texts** the tracker sends ("Waiting on you: …"): those are
  messages, not page labels.

### 1.3 The rule, word by word

1. Capitalise the **first word**, and the first word after a colon or an
   opening bracket: "Your Move (A Decision): Merge the Setup".
2. Capitalise **every other word**, except these small words, which stay
   lower case in the middle of a title: a, an, the; and, but, or, nor, for,
   so, yet; as, at, by, in, of, on, to, up, via, per, vs, with, from, into,
   onto.
3. A small word that is part of the verb is capitalised: "Set **Up** a
   Project", "Carry **On** with the Setup", "Sign **In**".

The check enforces 1 and 2 (it lets a small word be either, because only a
person can tell 3 apart); 3 is yours to get right.

### 1.4 Adding words to the page

- A new button, heading, toggle, tab, column heading or field label: Title
  Case.
- A label filled in at run time (`${…}`) is not checked; the words around it
  are.
- If the check finds fewer than a hundred labels, it fails on purpose: a
  pattern in `labelsOf` (`tracker/style.test.mjs`) no longer matches the
  page's source. Fix the pattern, never delete the check.

---

## 2. Tokens: type, colour, space, corners

Every size and colour comes from a named value (a CSS custom property, a
"token") defined once in `:root` at the top of `tracker/web/app.css`. The names
and values are StarCaster's, so the two projects can be compared line for line.
A literal colour (`#00AA00`) or font size (`13px`) in a rule is a bug; a
literal inside a `var(--x, #fallback)` fallback is allowed (MODULE_UI_DOCTRINE
R3, R8). `npm run verify` checks it (`tracker/cssTokens.test.mjs`, SP-320): no
literal colour, and no font size, corner or gap that is not a token, anywhere
below `:root`; and every token in the tables below is in `:root` with its value.

**Font.** `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica,
Arial, sans-serif`, with `-webkit-font-smoothing: antialiased`. Black text on a
white page, and `body` sets its background explicitly.

**Type scale.**

| Token | Size | Used for |
|---|---|---|
| `--text-xs` | 0.75rem (12px) | badges, counts, small-button text |
| `--text-sm` | 0.82rem (~13px) | table cells, field labels, buttons, the line under a title |
| `--text-base` | 0.9rem (~14.4px) | ordinary text, tabs |
| `--text-md` | 1rem (16px) | emphasised text, inputs |
| `--text-lg` | 1.1rem (~18px) | a section heading |
| `--text-xl` | 1.25rem (20px) | a column or card title |
| `--text-2xl` | 1.5rem (24px) | the page title (`--page-title-size`) |
| `--text-3xl` | 2rem (32px) | the largest display text, a big number |

Line height: `--leading-tight` 1.25 for headings and one-line controls,
`--leading-normal` 1.5 for text.

**Colours.**

| Group | Tokens |
|---|---|
| Ink | `--ink-primary #000`, `--ink-secondary #475569`, `--ink-muted #94a3b8`, `--ink-warning #b45309` (advisory, not failure) |
| Borders | `--border-light #e2e8f0`, `--border-strong #cbd5e1`, `--border-black #000` |
| Backgrounds | `--bg-page #fff`, `--bg-surface #fff`, `--bg-input #f7f9fc`, `--bg-hover #f1f5f9` |
| Status | `--status-ok #16a34a` (bg `#dcfce7`, ink `#15803d`); `--status-warn #d97706` (bg `#fef3c7`, ink `#b45309`) |
| Buttons | section 3 |
| Focus | `--focus-ring-color #2563eb` |
| Tabs | `--tab-selected #0b82d4` (the selected tab, section 5) |
| Highlight | `--mark-bg #fff3b0` (a search match) |

**Space.** `--space-1` to `--space-8`: 4, 6, 8, 12, 16, 24, 32, 48px. Gaps and
padding use these steps (checked by eye).

**Corners.** `--radius-btn` 10px for buttons, `--radius-input` 8px for boxes
and table wraps, `--radius-container` 20px for cards and pods.

**The tracker's own tokens.** A few parts of the page have no StarCaster
counterpart, so they have tokens of their own, in a separate group at the end of
`:root`: the black header and its colours (`--header-*`), the logo blue of the
Add Task box (`--brand-blue`, `--brand-blue-tint`), the light-blue pods and
their navy (`--pod-*`, `--navy`, `--navy-soft`), link blue (`--link-ink`),
error red (`--ink-error`, StarCaster's `--btn-danger-flat`), the table
heading and filter rows (`--table-head-*`, `--table-filter-*`, StarCaster's
T11 values, which its `_tables.css` writes as literals), shadows and the
dialog backdrop, the Console's feature colours (`--feature-0` to `--feature-9`),
small corners for tag chips and icon buttons (`--radius-sm` 4px) and round ones
(`--radius-pill`), and code text (`--text-code`, 0.9em of the text around it).
Colours Dane picked by hand keep their value as a token: the Pipeline Status
pod's green and gold (`--pod-running`, `--pod-soon`, SP-222). (The ticket
page's green buttons, `--ticket-btn-bg` from SP-76, went with SP-321, when every
button took a kind.) A new colour goes into `:root` with a name first; reuse a StarCaster
token wherever one means the same thing.

**Contrast.** Text is always readable on what it sits on; light text on a light
fill is a release-blocking bug (UI_RULES R1, R9). The one deliberate exception
is StarCaster's: white on its Save green, which Dane chose on 2026-08-30.

---

## 3. Buttons

Four kinds and two sizes, and nothing else (UI_RULES C9, 2026-11-05). A button
never sets its own height, padding or colour; it takes a kind.

| Kind | Class | Fill | Hover | Disabled | Use |
|---|---|---|---|---|---|
| Secondary | `btn` | white, `#000` text, `--border-strong` border | `--bg-hover`, `--ink-secondary` border | `--ink-muted` text, `--border-light` border | everything that is not one of the three below: Back, Cancel, Refresh, Import |
| Main action | `btn btn-primary` | blue `#0000cc` | `#0000a3` | `#aaaacc` | the one main action on the screen: "Add…", "Create…", Merge, Go |
| Save | `btn btn-save` | green `#00cc00` | `#00a300` | `#aaccaa` | every Save |
| Delete | `btn btn-danger` | red `#cc0000` | `#a30000` | `#ccaaaa` | anything that removes |

- Text on a filled kind is white. Font `--text-sm`, weight 600, line height
  1.2, 1px border, `--radius-btn`, no wrapping (`white-space: nowrap`), sized
  to its label (`width: fit-content`), never full width, and never squeezed
  narrower than its label in a row (`flex: 0 0 auto; min-width: fit-content`).
- **Heights**: `--btn-height` 32px, padding 0 0.875rem. Small (`btn-sm`)
  24px, padding 0 0.625rem, `--text-xs`, for buttons inside a table row.
- **One main action per screen**, and it sits in the title row (section 4).
  A screen with no main action has no blue button.
- **Disabled is a colour, never a fade** (`opacity`), and every kind has a
  designed hover.
- **Focus is visible**: `outline: 2px solid var(--focus-ring-color);
  outline-offset: 2px` on `:focus-visible`.
- **An icon-only button** is square, its icon centred (`inline-flex`), and
  carries an `aria-label`, which is its tooltip and its name for screen readers
  (section 1.1).
- **A choice inside a dialog** ("Overwrite", "Save & Publish") is the main
  action, blue, not green.
- **Which kind on the tracker** (SP-321): Merge, Go, Approve, Sign In, Email
  Me a Link, Upload Document, File in This Order, File in and the "Add…",
  "Create…", "Send…" and "Suggest…" buttons are the main action; every
  Save is a Save; Delete, Reject and every Remove are Delete; Post Reply, Add
  Comment, Close, Cancel, Copy, Edit and the rest are secondary. A button in a
  table row is small (`btn-sm`).

**Not a kind.** These buttons draw themselves in rules of their own, and are
the only ones the check lets through without `btn` (`EXCEPTIONS` in
`tracker/buttonKinds.test.mjs`, which names each one's class): the icon buttons
(`action`, `status-info`, `suggestion-info-open`, `drag-handle`, the
chips' `remove-tag` ×), a dialog's corner × (`close`), a table heading's
`sort`, "Forgot Password?" written as a link (`link`), a Console tile's
feature chip (`feature-pick`) and the Pipeline Status pod (`pipeline-pod`).
A new exception is added to that list, with its reason, in the same pull
request; anything else takes a kind.

This replaces two page-level looks Dane had asked for before: the ticket page's
all-green buttons (SP-76) and the Settings page's rounded dark-blue ones
(SP-289). He chose StarCaster's four kinds for every page on 2026-11-15.

---

## 4. The title row and headings

- **One title row per screen** (UI_RULES R11): the page title (`<h1>`,
  `--page-title-size` 24px, weight 800, line height 1.25) and the screen's
  buttons on the same row, the buttons at the right. Never two titles.
- **The trail stays.** The tracker's trail above the title (`nav.trail`:
  "Projects › Spirality › SP-12") does the job of StarCaster's "Section:" prefix,
  so the title itself is the bare name: "Tasks", not "Spirality: Tasks". Dane,
  2026-11-15.
- **At most one line under the title**: one sentence, 150 characters or fewer,
  `--page-desc-size` (`--text-sm`), `--ink-secondary`, and only when the screen
  needs it.
- **Nothing below the title is bigger than it, and there are three heading
  levels under it** (R10, R12): a column or card title (`--text-xl`, 20px,
  800), a section (`--text-lg`, 700), a sub-section (`--text-base`, 700), all
  `--ink-primary`.
- **No spaced capitals and no pill badge as a heading** (R12).

---

## 5. Tabs

Switching between views of the same thing is a tab, never a button (UI_RULES
C9, tabs): the Board / List / Console switch and the Settings tabs.

- A tab bar is its own row under the title, with a 2px `--border-strong`
  bottom border and 16px below it. One exception: the Tasks page's Board /
  List / Console tabs sit at the right-hand end of its title row, after the
  toolbar, with no gap below them and the line under them only as wide as
  the tabs (Dane, SP-326, 2026-11-16). The Settings tabs keep their own row.
- A tab is transparent text, padding 8px 16px, `--text-base`, weight 500,
  `--ink-secondary`; the selected one is `#0b82d4`, weight 700, with a 3px
  underline in the same colour.
- `role="tablist"` and `role="tab"` with `aria-selected`, or links with
  `aria-current` where each tab is its own address.

---

## 6. Forms

- **Every box has a permanent label** (MODULE_UI_DOCTRINE §2, Forms). The text
  shown inside an empty box is an example, never the instruction: not "Add a
  tag, then Enter".
- **A short setting keeps its label beside it; a text box takes its label
  above** (UI_RULES L9). Short settings are a colour, a switch, a number, a
  list to pick from. Labels are left-aligned, in a column `minmax(140px,
  max-content)` no wider than 16rem, and a label never wraps past two lines.
- **A box is sized to what goes in it** (W7, W1): `--field-w-number` 6ch,
  `--field-w-short` 24ch, `--field-w-long` 48ch, each plus 2rem for padding and
  never wider than its container. Several short boxes can share a row. A box
  is not `width: 100%` because the form is wide.
- **Box style**: 1px `--border-light` border, `--radius-input`, vertical
  padding `--field-pad-y` (`calc(0.55rem - 2px)`), `--bg-input`; on focus the
  border turns `--ink-primary`.
- **Radios and checkboxes**: the control on the left, its label on the right,
  one per line. Never a second caption repeating a checkbox's label.
- **A `<label>` wraps one simple control, never a widget that holds buttons**:
  a click on a label presses the first button inside it (StarCaster DOCTRINE
  §5.35).

---

## 7. Messages, empty states and wording

- **A message appears once, in one strip** between the header and the page,
  in normal flow, never floating over the work (UI_RULES S9, 2026-11-05).
  One message at a time; an error stays until its × is pressed, success and
  information close after four seconds, and the page scrolls the strip into
  view. Padding 8px 16px, `--text-sm`, weight 500, white text on success
  `#38a169`, error `#e53e3e`, information `#1a73e8`.
- **After a Save**, the page scrolls to the top and a small card says it
  saved, then fades by itself after three seconds, with nothing to close
  (MODULE_UI_DOCTRINE §2, Feedback, 2026-11-04).
- **An error says what happened and what to do, in terms of the thing the
  reader touches, and names the specific thing**; a message that cannot tell
  the cause says what happened and stops ([DOCTRINE.md](DOCTRINE.md) §2.1 to
  §2.3).
- **An empty list names what it would hold and why it is empty**: "Nothing is
  waiting on you", not "None." Dane cannot read the database, so empty and
  broken look the same unless the page says which ([DOCTRINE.md](DOCTRINE.md)
  §5.31).
- **When one action can mean two things, ask, naming both** (StarCaster
  DOCTRINE §2.4).
- **Labels are short and never wrap**; unclear wording is a bug; text is never
  cut through a word (UI_RULES L2, L3, L4, L7). Where text must be shortened,
  break between words.

---

## 8. Tables

- **One table look** (UI_RULES T11, 2026-11-05): the heading row is black with
  bold white text, left-aligned; a filter row (`tr.table-filter-row`), where a table has
  one, sits above it in `#b8e0ff` with `#0b3d7a` text, as StarCaster's T11
  has it, and scrolls away while the heading row stays. Heading cells are padded `calc(0.65rem - 2px) 0.85rem`, body
  rows 0.5rem top and bottom.
- **A table sits in a wrap** (`.table-wrap`): 1px border, `--radius-input`,
  at most `max(20rem, 100vh - 10rem)` tall, scrolling inside itself both ways,
  with the heading row fixed at the top while the rows scroll.
- **The page never scrolls sideways**; only a table's own wrap may (T0, T2,
  T8).
- **A name is never cut short** (T-1); an id is a link (T4); every row carries
  its full set of actions, in the last column, in one row of icons (T3).
- **A list that grows has search, filter and sort** (T1).
- **Sorting is a button in the heading cell, with `aria-sort`.** This is the
  one place the tracker differs from StarCaster on purpose: StarCaster forbids
  a button inside a `<th>` and sorts on a click of the cell itself, while the
  tracker's button (SP-174) can be reached from the keyboard and tells a
  screen reader which way the column is sorted.
- No `style=""` on a table, or anywhere else on the page.

---

## 9. Dialogs

A dialog is as wide as what is in it (UI_RULES D7): `width: max-content;
min-width: min(<floor>px, 100%); max-width: min(75vw, 100%)`, never a fixed
width on its own. Text inside it is no wider than 56ch.

---

## 10. Small rules that hold the rest together

- **Icons** are one line-icon family (Lucide), stroke width 1, in
  `currentColor`.
- **`!important` is a smell**: fix the rule that loses instead.
- **Every text box survives a 40-character word** with no spaces in it
  (`overflow-wrap: anywhere` on names, cells and cards).
- **Layout never lives only inside a breakpoint** (R1): a `@media` rule only
  adjusts a layout the base rules already set.
- **A section that opens and closes is a `<details>`**, or a button that
  changes `aria-expanded`; never one that rewrites its own HTML to swap an
  arrow.
- **Interactive things are real `<button>`s and links**, and an image has alt
  text.
- **A style written for a container must not reach the user's text inside
  it** (StarCaster DOCTRINE §5.36): ticket descriptions and comments keep their
  own formatting.

---

## 11. What is not adopted, and why

- **StarCaster's Builder**: its settings panels, field strips, panel lattice,
  spacing boxes, size steps and depth colours (UI_RULES D, W8, W9, the E rules
  of MODULE_UI_DOCTRINE), and its theme overrides (A).
- **Tenants' published pages**: the R rules of MODULE_UI_DOCTRINE §1b, the P
  rules, and all of `docs/DEVICE_STYLES.md` (desktop, tablet and phone styles
  of a tenant's page).
- **Phone layouts.** The tracker is built for one width, a desktop screen
  (SP-184, `docs/TRACKER_MVP.md`), so StarCaster's rules for narrow screens
  (the header folding behind a Menu button at 720px, the line under a title
  clamped under 640px) wait until it is not.
- **StarCaster's `docs/Markdown Files/STYLE_GUIDE.md`** (April 2026): its
  sections on buttons, forms and the line under a title are superseded by the
  rules above, in StarCaster too.

---

## 12. Where the tracker stands

Measured 2026-11-15 on `tracker/web/app.css`, `app.mjs` and `render.mjs`.

| Section | Today | Brought into line by |
|---|---|---|
| 1 Capital letters | Buttons, headings, toggles, columns, tab titles and trail: followed and checked. Field labels and tabs: sentence case in places, not checked. | SP-325 |
| 2 Tokens | Followed and checked (SP-320, 2026-11-15): every colour, font size, corner and gap is a token in `:root`, StarCaster's where it has one. Padding and margins are still literal lengths, near the steps. | SP-320 |
| 3 Buttons | Followed and checked (SP-321, 2026-11-15): every button is `btn` plus a kind, or a listed exception; 32px and 24px; disabled is a colour; focus ring on every kind. The ticket page's green, Settings' dark blue and the black link are gone. | SP-321 |
| 4 Title row | Followed and checked (SP-322, 2026-11-15): a 24px, weight 800 `<h1>` on every page, and every toolbar in the title row at its right, the trail above it; headings under it at `--text-lg` (h2) and `--text-base` (h3 to h6), with board columns and Console stages at `--text-base`. The ticket page keeps its two-column top, whose actions sit in the right column. | SP-322 |
| 5 Tabs | Followed and checked (SP-322, 2026-11-15): Board / List / Console and the Settings tabs are one tab bar (`nav.tabs`), links with `aria-current`. Board / List / Console sit at the right of the Tasks title row (SP-326, 2026-11-16); the Settings tabs on a row of their own. | SP-322, SP-326 |
| 6 Forms | Every label above its box; boxes full width; tag boxes use the text inside the box as the instruction. | SP-325 |
| 7 Messages | Notes beside each button and under the title; no single strip. Empty states: followed, but for a bare "None." | SP-323 |
| 8 Tables | Followed and checked (SP-324, 2026-11-16): black heading rows with white text, every table with headings in a `.table-wrap` with its heading row fixed, sort buttons kept in the heading cell. No table has a filter row yet; the rule for one is in place. | SP-324 |
| 9 Dialogs | Followed and checked (SP-324): every dialog is `max-content` wide between its own floor and 75% of the screen; text in it at most 56ch. | SP-324 |
| 10 Small rules | Followed; icon strokes are 1 and checked (SP-320). | SP-320 |

**The checks.** `tracker/style.test.mjs` checks section 1;
`tracker/cssTokens.test.mjs` checks section 2 and the icon strokes of section 10;
`tracker/buttonKinds.test.mjs` checks section 3;
`tracker/titleRow.test.mjs` checks sections 4 and 5;
`tracker/tablesDialogs.test.mjs` checks sections 8 and 9.
Each ticket above
adds the check for its part to `npm run verify`, as StarCaster's
`scripts/check_ui_doctrine.cjs` does for its screens: every `<button>` has a
kind; no literal colour or font size outside `:root`; no `style=""`; no
`opacity` on a disabled rule; dialog widths; every box has a label.
