## 2026-11-13 — A pull request waiting in Ready to launch goes stale when main moves, and the conflict shows only at Dane's merge word: after each merge, catch it up or file its fix-up at once (#224)

When one piece of work merged, the system already warned the work still being
built or reviewed that the shared code had changed under it. It said nothing to
the work sitting finished in Ready to launch, waiting for Dane's yes. That work
went stale quietly, and a clash only showed up at the moment Dane said merge.
Then came a fix-up ticket, another build and another review, all starting from
his word. A quarter of everything that went live since late October hit this,
and his yes sometimes comes hours later, so all that waiting time was wasted.

Now, every time the relay merges something, it also checks each Ready to
launch pull request against the new code, the same way it checks the others.
If the two fit together, it brings the branch up to date at once, so the checks
re-run and it is ready and green when Dane says merge. If they clash, it files
the fix-up ticket straight away, so the build loop is already fixing it while
Dane hasn't looked yet. It never moves Dane's ticket, never resolves a clash by
itself, and leaves the branch alone while another merge is in progress.

After review sent it back once: the fix-up ticket filed this way now says
plainly that it is a real clash to resolve (it used to tell its builder to
"find out" whether there was one, right under a line saying git had found
it), and its test steps are ones that can pass before Dane says merge. A
branch whose fix-up ticket is still being worked is left alone, so nobody's
half-finished fix gets code pushed underneath it. And if the record of which
merge is in progress cannot be read, the relay now says so instead of quietly
skipping the catch-up forever.
