## 2026-11-01 — Github repository field for Projects? (#62)

Dane asked whether a project should say which GitHub repository it lives in,
and answered his own question with "A, B, and C". This is A: every project in
the tracker can now hold its GitHub repository, typed as `owner/name` or pasted
as its github.com address (saved the short way either way). The New and Edit
project forms have the box, the project's page and the Projects table show it
as a link to GitHub, and anything that is not a GitHub repository is refused
with a plain message instead of being saved wrong.

Nothing reads it yet: the loops still learn the repository from each product's
own settings file. That is on purpose. The field is the first piece of adding
a new product such as Normie; the checklist of everything else a product needs
(SP-88) and planning Normie's setup (SP-89) are their own tickets.
