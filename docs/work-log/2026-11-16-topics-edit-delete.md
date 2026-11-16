## 2026-11-16 — Edit and delete topics on the Topics page (#270)

Until now a topic could only be added: a typo in a topic's name, or a topic nobody
wanted any more, stayed for good. Each row of the Topics table now has an Edit button
and a Delete button.

Edit turns the row into the same Name and Description boxes as the Add Topic form,
with Save and Cancel. A blank name is refused before anything is sent.

Delete asks first and says how many tasks carry the topic, so nobody removes a busy
one by accident. Saying yes removes the topic and takes it off every task that had it.
Each of those tasks shows the change in its history, as if someone had removed the
topic by hand. It all happens in one step: if anything fails part-way, nothing changes.

After either change the page reads the list back from the tracker. It only says the
change worked if that read shows it.
