## 2026-11-02 — Nobody has written down what a new product needs to run on Spirality: a checklist (#67)

Dane asked what a project needs before its development can run on
Spirality, ready to bring Normie over. The answer was scattered over the
settings file, the installer, the tracker and Doppler. Now it is one page,
`docs/ONBOARDING_A_PRODUCT.md`: six things a product needs, each with where
it lives, who does it, how to tell it is done, and whether a command does it
today, a person does it by hand, or nothing does it yet.

Writing it down turned up four things that would bite on the first new
product: there is no shared package for a product to depend on yet; a few
scripts still say "spirality" where they should read the settings file; the
loops' tracker sign-ins are shared by name, so setting them up for a second
product would cut off Spirality's own loops; and the tracker's new GitHub
repository field is not what the loops actually read. Planning Normie's
setup (SP-89) starts from that list.
