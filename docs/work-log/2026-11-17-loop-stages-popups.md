## 2026-11-17 — Show the four pipeline stages on the Loop Queue diagram with info popups (#321)

The Docs page's Loop Queue diagram now shows where each of the four
pipeline stages does its work. Under the picture sit four buttons, Relay,
Build, Review and Intake, the same names in the same order as the Pipeline
Stages box on Tasks and the Console. Pointing at one, or tabbing to it,
outlines on the picture the arrows that stage moves tickets along: Review
lights up Passes, Sent back and Judgment call. Clicking one opens a short
pop-up saying which lane runs it, how often, and what it reads and moves.

Why it matters: the Pipeline Stages box says when each stage runs next, but
not what each one does to a ticket. Now the diagram answers that, so the
names on the box and the arrows on the picture explain each other. A test
keeps every arrow owned by exactly one stage, so a new arrow cannot be left
unexplained.
