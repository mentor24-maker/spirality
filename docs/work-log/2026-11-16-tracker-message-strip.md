## 2026-11-16 — Show tracker messages in one strip under the header (#265)

The tracker page reports what happened in lots of different places:
"Saving…" and "Saved" beside each button, red error text under a form, a
line under the title. StarCaster puts all of that in one coloured strip right
under the black header, and this is the first step of the tracker doing the
same.

The strip now exists. Red means something went wrong, and it stays until you
close it with its ×; green means it worked and blue means it is working, and
both go away on their own after four seconds. After a Save, the page jumps
to the top and a small card says what was saved, then fades.

Only one button uses it so far, as Dane chose: the Save under Stage Colours
on the Settings page. Every other page keeps its notes where they are until
its own ticket moves it, so nothing else changes on this pull request. A new
check in `npm run verify` counts the notes beside buttons and fails if one is
added, so the number only goes down from here.

One empty spot now says what it would hold: an empty board column says
"No tickets are in Queued right now." instead of "None.".
