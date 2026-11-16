## 2026-11-15 — Move the loop's doctrine and StarCaster's style conventions into Spirality (SP-318)

The loop was built inside StarCaster, so the lessons it learned the hard way
were written into StarCaster's doctrine, and stayed there when the loop became
Spirality. Spirality's own code still cited them by number, 67 times, and
those numbers pointed at nothing here.

Now `docs/DOCTRINE.md` holds them: 53 sections, every one about the loop or a
general rule both projects need, under the numbers StarCaster gave them, so
"DOCTRINE 3.11" in a comment finds its rule. Each incident is told as it
happened; where Spirality is different today, a line starting "In Spirality
now" says how. One rule was retired rather than moved (§6.21, about
ClickUp's audit trail, which the tracker replaced), and the sections about
StarCaster's own application stay in StarCaster.

The look of the tracker page moved to a new `docs/UI_DOCTRINE.md`: the Title
Case rule as it was, now covering field labels and tabs too, and StarCaster's
conventions for buttons, colours, type, titles, tabs, forms, messages, tables
and dialogs, with their values, so the two projects look like one. The page
does not follow most of it yet; its last section says where it stands, and
six tickets (SP-320 to SP-325) bring it into line part by part.

The wording check no longer reads the operator prompt files, which keep
Dane's words exactly as he typed them.
