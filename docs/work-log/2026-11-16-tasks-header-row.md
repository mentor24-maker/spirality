## 2026-11-16 — Rearrange the Tasks header (#273)

The top of the Tasks page was taller than it needed to be. The title, the
project picker, the search box and the Pipeline Stages box sat on one row,
and the Board / List / Console tabs had a whole row to themselves underneath.
The Pipeline Stages box was tall and narrow: each stage on its own line, its
time beside it.

Now everything fits on one row. The tabs moved up to the right-hand end of
the title row, on Board, List and Console alike, so they never jump when you
switch. The Pipeline Stages box turned on its side: the four stage names run
along the top with each time or status directly under its name, and the box
stretches across the free space in the middle of the row. Colours, the hover
text and what clicking it opens are all as before.

On a narrow window the row wraps onto more lines rather than squeezing the
search box to nothing. The page's style rules (UI_DOCTRINE section 5) said a
tab bar always gets its own row; they now name the Tasks page as the one
exception, at Dane's word. The Settings page's tabs keep their own row, and
a test now checks that they do.
