## 2026-11-11 — Check project permissions on web-based UI (#175)

Dane noticed that his second account, Dane of Earth, could open every
project even though it was only on Normie and PressPlay. Nothing was broken:
an admin sees every project on purpose, so nobody can ever be locked out of
one. But the Users page gave no sign of this, so it looked like a fault.

Dane chose to keep the rule and make it visible. On the Users page, an
admin's Projects cell now starts with **All projects (admin)** in bold, with
the projects they actually belong to listed underneath as before. Everyone
else's cell is unchanged. The label comes from the same check the tracker
uses to decide what a person can see, so the page and the rule always agree.

To use Dane of Earth as an ordinary test user, change its role to editor on
the Users page; after that it sees only its own projects.
