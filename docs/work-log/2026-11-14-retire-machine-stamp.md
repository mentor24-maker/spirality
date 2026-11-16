## 2026-11-14 — Every comment still carries the machine stamp: retire it once no product reads ClickUp (#233)

When the loops lived on ClickUp they posted under Dane's own account, so a
loop's comment looked exactly like one of his. To tell them apart, every
loop comment ended with a "[machine] … not his word" line, and anything
that asked "did Dane answer?" skipped those comments. It worked, but it
could go wrong both ways: a loop comment missing the line read as Dane's,
and a comment where Dane pasted a loop's card under his own words read as
a loop's. That second case could have let the auto-merge lane merge a pull
request he had just told it to hold.

Now all three projects run on the tracker, where each loop signs in as
itself. So the loops now tell Dane from a machine by **who wrote the
comment**, which the tracker already records, and the extra line is no
longer written. Old comments copied over from ClickUp keep the line as
history; nothing reads it, and the tracker page hides it. The rulebook
(`docs/LOOP_CONTRACT.md`, "Who is talking") says the same in plain words.

Checked against a copy of the live tracker: no comment by a person carries
the line, and the "waiting on Dane" answer is the same before and after.
