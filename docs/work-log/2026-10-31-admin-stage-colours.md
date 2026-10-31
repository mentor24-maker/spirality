## 2026-10-31 — In the Admin page, a setting to choose colors to represent stages (#46)

The tracker's page now has a **Settings** screen (at `/settings`), reached from
the header menu. The ticket asked for an "Admin" page; Dane renamed it to
Settings before it was built, so that is the name everywhere.
It lists the eight stages a ticket moves through (Requested, Rework, Queued,
Building, In review, Needs your input, Ready to launch, Live), in the same
order as the board, each with a colour picker and a Clear button. Pressing
Save stores the colours on the tracker itself rather than in one browser, so
every computer and every person sees the same ones.

The page checks its own work: after saving it reads the colours back from the
tracker and only says "Saved" when they match. Only a person can change the
colours; a loop trying to is refused, and a value that is not a proper colour
code is refused with nothing stored.

Nothing else looks different yet. Using these colours on the Tasks page
(headings, header bars and borders) is the next ticket, SP-61.
