## 2026-11-02 — Update the visible Status of updated projects more quickly (#69)

When Dane pressed Merge, his word went in at once, but the relay only acts on it every ten minutes. Until then the ticket looked exactly the same, Merge button and all, so he pressed it again; three real tickets show it happening.

Now the tracker page notices when his own comment is the newest word on one of his tickets. The ticket page says "Your answer is in. The relay acts on it at its next pass." in place of the Merge, Close and Go buttons, and the board and list show a short "your answer is in" note beside the ticket. When the relay answers, the note goes away by itself and the buttons come back.

It uses the same rule the Waiting on you list already uses to drop an answered ticket, so the two can never tell him different things. Nothing new is stored, and the relay's timer is unchanged. Making open pages refresh on their own is the next slice, SP-94.
