## 2026-11-17 — A ticket with no pull request cannot be closed with "close": the review card asks for it and the relay refuses it (#305)

Some tickets are jobs done on the Mini, with no code to merge. When the
review loop finished one of those (SP-370), it asked Dane to write "close",
and then the relay, the part that acts on his words, refused his "close"
three times. Its rule said a ticket only closes once its pull request is
merged, and this one had none, so a session had to close it by hand.

Now the relay looks at the question Dane was answering. If the ticket has no
pull request at all and the review card asked him to close it, his "close"
moves it to Live on the next relay pass, with the usual reply saying so.
Every ticket that does have a pull request keeps the old rule, so nothing
whose work never landed can be closed this way.
