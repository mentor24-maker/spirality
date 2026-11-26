## 2026-11-26 — A ticket whose pull request already merged sits in Ready to launch forever instead of going Live (#338)

Seventeen WaveCenter tickets sat in Dane's "Ready to launch" column for two
days even though their work was already in. Each one's pull request had been
merged under a different ticket's approval, so nobody ever wrote "merge" on
these tickets. The relay only finishes a merged pull request when it sees
that word, so it never touched them. The review step had also parked them on
Dane with a "please merge" card, for work that was already merged. They were
on no list and in nobody's hands until a hand-run session cleared them.

Now the relay checks each Ready to launch ticket's own pull request even when
Dane has said nothing. If GitHub says it is merged, the relay moves the
ticket to Live (or back to Queued when more slices remain), reads the move
back, and leaves one note saying it was merged elsewhere. An open pull
request, one GitHub can't read, or an older slice's merge leaves the ticket
exactly where it is. The review step's tidy-up command (`fixup-live`) now
closes such a ticket itself, so it never reaches Dane in the first place.
