## 2026-11-04 — Setting up a product takes days of tickets: one onboard command that asks once and runs every step (#95)

Setting up Normie on Spirality took many tickets and several days. Most of
that time went to waiting between hand-run steps, not to the steps
themselves. The last few tickets turned each step into its own script; this one adds the command that runs them all in order:
`npm run onboard -- --product <slug>`.

It asks Dane only what is his to decide, once, and keeps his answers in a
file. After that it stops for him only twice: one block to paste for the
secret keys, and his usual merge phrase on the setup ticket. Every step
checks first whether it is already done, so if something fails partway,
running the same command again picks up where it stopped and asks nothing
twice. Every failure says plainly which step failed and what it saw, and
nothing after that step runs. At the end it protects the product's main
branch so nothing reaches it unchecked, then reads that setting back from
GitHub to make sure it took.

PressPlay is meant to be its first real run, started by Dane.

After review: the first version would have stopped every real setup at the
lanes step. The copy step leaves its own working folder on the setup branch,
and git lets a branch be open in only one place, so installing the lanes from
that branch was refused, on every rerun too. The wizard now closes that
folder (its work is already pushed) and checks nothing still holds the branch
before the lanes step. Three smaller fixes came with it: the rerun line keeps
a longer merge wait the run was started with; the Terminal prompt opens only
while a question is asked, so Ctrl-C stops the wizard during the long waits
and a stray Enter no longer answers the paste-block wait (it now waits for the
word `done`); and when a bad answer cannot be taken back out of the answers
file, the failure says so instead of promising a rerun will ask again.
