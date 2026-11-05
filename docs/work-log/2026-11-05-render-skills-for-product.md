## 2026-11-05 — A product's copied skills cite Spirality's ticket ids, docs it does not have and a CLAUDE.md section it lacks: render them for the product (#100)

When a new product is set up, it gets a copy of the four instruction files
the loop's passes follow. Those copies still talked as if they lived in
Spirality: they gave Spirality's ticket numbers as examples, told a pass to
read two documents the product does not have, and pointed to a section of
the product's guide under a name the guide does not use. PressPlay's review
lane tripped over this on its first ticket.

The setup now rewrites those passages as it copies them: example ticket
numbers use the product's own prefix, past incidents are labelled as
Spirality's, the two documents become links to Spirality's copies, and the
guide's section is called by its real name, "Loop rules". A new check
renders the copies for a pretend product and fails if any of these slips
back in.
