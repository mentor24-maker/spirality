## 2026-11-10 — Make the relay run StarCaster's auto-merge lanes up to a would-merge note, without merging (#163)

StarCaster lets some small, safe pull requests (tests and documents, or the
loop's own scripts) merge without Dane saying "merge": the relay announces
one on its ticket, gives him an hour to object, and merges if he says
nothing. Spirality's relay could not do that yet, so StarCaster could not
move onto it.

This is the middle step of three. Spirality's relay now does everything
StarCaster's does except the merge itself: it announces, it cancels the
moment Dane comments, it obeys "stop auto-merging" on the bus or on a ticket
(and treats a bus or record it cannot read as a stop), it limits how many
can happen in an hour and a day, it switches itself off when a pass could
not check something, and it posts a daily summary. When the hour is up it
writes one comment saying it **would** merge now, and stops there. The
ticket keeps waiting on Dane's word, exactly as before.

It only runs for a project whose settings list lanes. Spirality and
WaveCenter list none, so for them nothing changed. That lets the whole
routine be watched on StarCaster's real tickets before anything merges
without Dane; the third step makes the end of the hour a real merge.

Review sent it back once: after the "would merge" comment, the relay kept
watching the ticket as if the hour were still open. A question from Dane
afterwards, or the ticket simply sitting a day, made it post a wrong
"Auto-merge stopped" message. Now the "would merge" comment closes the
matter: after it, the relay says nothing more on that ticket and leaves it
waiting on Dane's word. Two new tests show both cases stay quiet.
