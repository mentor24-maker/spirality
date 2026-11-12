## 2026-11-11 — Board view cuts off two columns (#185)

The Board on a project's Tasks page showed only five of its seven working stages; Needs your input and Ready to launch, the two that are Dane's, were hidden off to the right until you scrolled sideways. Each column had a fixed width that was too wide for seven to fit on the page.

The columns now share the page's width equally, so all seven sit side by side on a laptop or desktop screen with nothing to scroll. Long ticket names wrap inside their cards instead of stretching a column. On a narrow window the columns shrink together down to a readable minimum, and only then does the board scroll sideways, as it did before.

A new automatic check reads the page's stylesheet and fails if the columns ever go back to a width where seven cannot fit.
