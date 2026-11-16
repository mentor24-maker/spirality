## 2026-11-16 — Show tracker messages in one strip under the header (#265)

The tracker page used to report what happened in lots of different places:
"Saving…" and "Saved" beside each button, red error text under a form, a
line under the title. Now every one of those appears in the same place, a
coloured strip right under the black header, the way StarCaster's admin
screens do it. Red means something went wrong, and it stays until you close
it with its ×; green means it worked and blue means it is working, and both
go away on their own after four seconds. After pressing a Save, the page
jumps to the top and a small card says what was saved, then fades.

It was done without rewriting each button: every button still writes its
message where it always did, that spot is now hidden, and one small watcher
copies the newest message into the strip. So a button added later reports
in the strip too, without anyone remembering to.

Two empty spots now say what they would hold: an empty board column says
"No tickets are in Queued right now." instead of "None.", and a ticket with
no tags says "No tags yet".
