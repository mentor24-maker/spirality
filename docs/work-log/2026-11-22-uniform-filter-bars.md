## 2026-11-22 — Make the filter bars on every tracker page look and read the same (#335)

The row of dropdowns under each page title, the filter bar, had grown up
separately on each page. Reporting drew its own project dropdown, labelled
"Project" with no colon and offering "All projects" in lower case. Its Kind
dropdown said "All Kinds" where the Tasks page says "Any". On Board and List,
the Kind, Started By and How It Ended dropdowns sat after the search box and
the Pipeline Status box, not beside the other dropdowns.

Now every page with a project dropdown (Board, List, Console, Topics, API
Usage and Reporting) draws the same one. It always reads "Project:", and
"All Projects" is spelled the same everywhere the page can show every project.
Every bar puts its controls in the same order: Project first, then the other
dropdowns, then Search, then the Pipeline Status box. "Any" means "no filter"
on every dropdown but Project. The labels share one look, and the bars wrap the
same way on a narrow window. No filter does anything new, and none was added
or taken away.

A new test reads every page's code and fails if a page builds its own project
dropdown or spells "All Projects" its own way. The bars can't drift apart
again without a test catching it.
