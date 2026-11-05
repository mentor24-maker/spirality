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
