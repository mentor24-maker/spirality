## 2026-11-16 — Put the Loop Queue diagram on the Docs page with each status linking to its anatomy section (#283)

Dane's Spirality Loop Queue picture, the one showing how a ticket moves
from Requested to Live, now sits at the top of the Docs page's right-hand
column. Each of its eight status boxes is a link: clicking "Rework", say,
opens the Loop Queue Anatomy page at its Rework section, so the picture
works as a map into the longer explanations.

The tricky part was keeping the clickable spots on their boxes when the
picture shrinks on a narrow screen. An old-style image map uses fixed
pixel positions and drifts; placing spots by percentage would need a kind
of styling the page's security rule blocks. So the links are drawn as an
invisible layer measured in the picture's own pixels, which shrinks and
grows with it exactly. The boxes can also be reached with the Tab key,
each showing a blue outline, and the tests check that every link points
to a section the anatomy page really has.
