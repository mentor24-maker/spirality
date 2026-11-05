## 2026-11-04 — A new product's go and merge wait until its lanes are installed last: install them from the setup branch so its own relay merges it (#90)

When Normie was set up, its lanes (the jobs on the Mini that build, review
and merge its tickets) were installed last. Until then nothing listened for
Dane's "go" and "merge" in Normie's project: he wrote several of them twice,
and the final "merge" sat overnight, because the relay that acts on it was
the very thing being installed.

This adds the wizard's lanes step, `npm run onboard:lanes`. It puts the
product's checkout on its setup branch, files one ticket for the setup pull
request in the product's own project, installs the lanes from that branch,
and checks that each lane's first pass actually did its job. Normie's review
lane, on its first pass, stood down because it mistook itself for a second
reviewer, and that now counts as a failed step instead of passing unnoticed.
The product's own lanes then review and merge the setup pull request on
Dane's word, like any other ticket.

The runners also learned one new move: once that setup branch has merged
and GitHub has deleted it, they put the checkout back on `main` by
themselves, so the lanes never keep running the setup branch's old code. They
only do it when nothing is uncommitted and GitHub has clearly said the branch
is gone.
