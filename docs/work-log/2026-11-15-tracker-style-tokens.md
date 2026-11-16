## 2026-11-15 — Add StarCaster's colour, type, space and corner tokens to the tracker page (#260)

The tracker page and StarCaster are meant to look like one family. Until now
the tracker's stylesheet typed its colours and sizes straight into each rule:
about 45 colours, 16 text sizes and 11 corner sizes, each chosen on the spot.
StarCaster keeps one list of named values instead, and every rule refers to a
name.

The tracker now does the same. The stylesheet starts with one list (its
`:root` block) that holds StarCaster's names and values for text sizes, inks,
borders, backgrounds, status colours, spacing steps and corners, plus a short
group for parts of the tracker StarCaster has no match for: the black header,
the logo blue and the Console's feature colours. Colours Dane picked by hand,
such as the Pipeline Stages pod's green and gold, keep their exact value under
a name. Icons are drawn with StarCaster's thinner 1-pixel line.

A new check in `npm run verify` reads the stylesheet and fails if anyone types
a colour, text size, corner or gap into a rule again, so the page cannot drift
back. The page looks almost the same: text is pure black, quiet text is
StarCaster's slate grey, and a few corners and gaps moved a pixel or two to
land on the shared steps.
