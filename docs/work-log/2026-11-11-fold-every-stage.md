## 2026-11-11 — Make stages on Tasks page collabsable/expandable (#173)

Until now, only the Live stage on the Tasks page could be folded shut. Now
every stage can: click a stage's heading on the Board or the List and it
folds down to just its heading bar; click again and it opens. Each heading
now reads the stage name on the left, the number of tickets on the right,
and a small arrow after the number that points down when the stage is open
and right when it is folded. Live still starts folded and the rest start
open. A folded Board column keeps its place and width, so the board does not
shift around. A stage you fold stays folded when the page refreshes itself
every minute, even if someone changes that stage's colour in the meantime.
It does not remember after a full reload; that was left out on purpose.
