## 2026-10-31 — The stage colours picked on the Admin page do not show yet: colour the Tasks page's stage headings and borders with them (#50)

Dane could already choose a colour for each stage of the loop on the
Settings page, but nothing used it. Now the Tasks page does, on both the
board and the list: each coloured stage gets a border in its colour, a pale
tint of the colour behind its heading, and its heading words in the colour,
so a stage can be spotted at a glance.

Two things keep it from ever looking broken. The heading bar is always a
light tint, and if a colour is too pale to read on it (yellow, say) the
heading words are darkened just enough to read. And only a proper colour
code is used: a stage with no colour, a bad saved value, or colours the page
cannot fetch all simply look the way they did before.
