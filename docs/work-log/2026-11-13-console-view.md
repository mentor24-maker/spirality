## 2026-11-13 — Show the Console view of tasks in flight (#210)

The Tasks page had two ways to look at work: Board (columns of cards) and
List (rows of text), one project at a time. It now has a third, **Console**,
meant to be read at a glance like an air traffic controller's screen.

Every ticket that is still moving, across every project you can see, is a
small square tile. The picture is the project's logo (or its short prefix,
like `SP`, when it has none), the ticket number sits large across the
middle, and the bottom row says what stage it is in, when something will
next happen to it ("in 12 min", "Now", or "You" when it is your move), and
how long it has been in that stage. Tiles waiting on you have a gold ring
so your moves stand out. The tiles are grouped into one column per stage,
left to right in the order work flows.

Click a tile to open the ticket. Once you pick Console, the Tasks link in
the header remembers it. The page refreshes itself every minute so the
countdowns stay true. Nothing about Board, List or the data behind them
changed; colour-coding tiles by feature comes in the next slice.

**After review.** Review found that the Console jumped back to its left edge
every minute when it redrew, so on a laptop-width window the two columns
that are Dane's own moves (Needs Your Input and Ready to Launch) kept
sliding out of view. The minute's redraw now remembers how far across he
has scrolled and puts it back, the same way it already kept how far down.
The same redraw used to fetch the in-flight list twice a minute (once to
compare, once to draw) and now fetches it once. And "next change" now
counts hours down the way it counts minutes: 89 minutes away reads "in 1 h",
not rounded up to 2.
