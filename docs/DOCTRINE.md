# Doctrine: how the tracker page looks and reads

Spirality's style conventions, so every page of the tracker reads as one
thing. Any change that adds or renames words on the page follows this file.
`npm run verify` checks the capital-letter rule (`tracker/style.test.mjs`), so
a label that breaks it fails the pull request.

## 1. Capital letters on the page

Dane chose this on SP-138, "Make formatting consistent. Establish style
conventions doc" (2026-11-05): **Title Case** for the words that name a thing
you click or a part of the page.

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
- **The tab title and the trail at the top of the page**, which repeat the
  page's heading: "Set Up a Project · Tracker".

### 1.2 What stays as it is written

- **Sentences**: help text, notes under a button, error messages, the words
  on a form field ("Reply as Dane", "Invite someone"), the "nobody" and
  "none" placeholders. They are sentences, so they take sentence case.
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

- A new button, heading, toggle or column heading: Title Case.
- A label filled in at run time (`${…}`) is not checked; the words around it
  are.
- If the check finds fewer than a hundred labels, it fails on purpose: a
  pattern in `labelsOf` (`tracker/style.test.mjs`) no longer matches the
  page's source. Fix the pattern, never delete the check.
