# ClickUp setup for the Spirality Loop Queue — the statuses

The **Loop Queue** list in the **Spirality** space was created on 2026-10-11
(list id `901418065068`). A list made through the API starts with the space's
default statuses (`to do`, `in progress`, `complete`). The loop needs seven
specific names, and **ClickUp's API has no way to edit a status set**,
so this one step is done by hand in the ClickUp web app. It takes about three
minutes. Everything else is automated.

ClickUp moves its menu labels around between releases. The paths below are
what to look for, not a guarantee of exact wording.

## 1. Edit the statuses on the SPACE, not the list

All three lists in the Spirality space share the space's statuses, and the
whole space exists for this project, so one status set on the space is the
simplest arrangement. (2026-10-11: Dane opened the space-level dialog, "Edit
Spirality statuses", and that is the right one.)

1. In the left sidebar, hover the **Spirality** space, click the **`…`**,
   then **Space settings** → **Statuses** (ClickUp sometimes calls it
   **Edit statuses**).
2. The dialog is titled **Edit Spirality statuses** and shows four groups:
   Not started, Active, Done, Closed.

**Rename in place — never delete a status and re-create it.** Renaming carries
the existing tickets across untouched; deleting forces every ticket in that
status into some other one. The queue already holds tickets.

**Make one change, then click Apply changes, then the next.** The dialog's
duplicate check ("Status name is already taken") fires on any two rows with
the same name, including a half-typed "Add status" row left over from earlier
in the same session. If it fires on the first rename with no visible
duplicate, close the dialog with the X (nothing is saved until Apply), reopen
it, and if needed rename to a temporary name (`Queued2`), Apply, then rename
again.

## 2. Rename the three defaults

| Rename this | To this |
|---|---|
| `to do` | `Queued` |
| `in progress` | `Building` |
| `complete` | `Live` |

## 3. Add four more

Click **+ Add status** (or the `+` at the bottom of a group) and add:

| Add | In which group |
|---|---|
| `Rework` | Active |
| `In review` | Active |
| `Needs your input` | Active |
| `Ready to launch` | Active |

Then drag them into this order, top to bottom:

```
Rework
Queued
Building
In review
Needs your input
Ready to launch
Live
```

### The one setting that matters most

ClickUp sorts statuses into groups — **Not started**, **Active**, **Done**,
**Closed**. A ticket only stops counting as open when its status sits in the
**Closed** group.

**`Live` must sit in the Closed group.** Renaming `complete` (which is already
the space's Closed status) is what makes this true without any dragging. If
`Live` ends up anywhere else, finished work piles up in the open view forever.
Leave `Queued` in Not started and the rest in Active.

### Colours worth setting

Click the coloured circle to the left of a status name:

- `Needs your input` — red
- `Ready to launch` — green
- Leave the machine statuses muted (`Queued` grey, `Building` purple,
  `In review` amber, `Rework` grey).

`Live` cannot be recoloured; ClickUp locks Closed statuses to green.

### If the Edit Statuses dialog opens EMPTY

On StarCaster's list-level status set this dialog once opened with all four
groups blank, from three different doors. It is a display bug, not data loss —
but **do not press Apply on an empty dialog**; it could strip the statuses.
Instead, in List view, hover the status pill at the head of any group, open
its `…` menu and use **+ New status** and **Rename** there; those work inline.

## 4. Tell the session the rename is done

Say "statuses done" in your Claude Code session. It will run

```
npm run clickup -- queue
```

and should print every ticket with status `queued` (lower case is how ClickUp
reports it). That is the check. If any ticket still says `to do`, step 2 did
not take.

## Finding what needs you

Nothing to build. Use ClickUp's own **Assigned to me** (sidebar → **My
Tasks** → *Assigned to me*). The loops assign Dane when a ticket enters
`Needs your input` or `Ready to launch`, and clear the assignee when they take
it back, so that built-in view is already the complete picture — across every
space, StarCaster and Spirality alike.
