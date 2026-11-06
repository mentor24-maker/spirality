## 2026-11-05 — The tracker cannot show or save a product's setup: add the setup's answers, status and commands to its server (#104)

Setting up a new product meant answering the wizard's questions in a Terminal. Dane wants to do it from the browser instead, copying only the odd command to paste on the Mini. This is the middle piece of three: the tracker's server can now hand a page the setup questions with their defaults, save the answers he types, say how far each product's setup has got, and give the exact command to paste to start or carry on.

It stays careful: only a signed-in person can use it (never a loop), the answers are checked by the same rules the wizard uses, and once the setup has made the product's sign-ins from them, the page can no longer change them. The server never runs the setup itself; it only reads the wizard's files and writes the one answers file. The page that uses all this is the third ticket.
