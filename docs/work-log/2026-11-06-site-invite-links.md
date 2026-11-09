## 2026-11-06 — A teammate invited to Spirality cannot join from StarCaster's page: send invite and reset links to the site's own page (#121)

Dane wants his team to use Spirality from a page on StarCaster: finish
joining from an invite, sign in, see the tasks, file a request and reset a
forgotten password, all without opening the tracker's own page. Until now
every emailed link (invite or reset) could only open the tracker's page, so
StarCaster's page had no way to take a new teammate through joining.

Now the tracker can know about an "outside site": a page address stored
once on the Mini, never in the code. When Dane invites someone, the Users
page asks where the link should open, the tracker page or the site. When
the site's server asks for a password reset using the site's own key, the
reset link opens on the site too. It is still invite-only: there is no way
to make an account without an admin's invite.

A new document, `docs/OUTSIDE_SITE_API.md`, lists every call StarCaster's
server makes, in order, with an example of each, so the StarCaster side
can be built against it. The task list StarCaster will draw comes from the
tracker's board call, and a test now pins its shape, so a later change here
fails the checks instead of quietly breaking StarCaster's page.

**After review (2026-11-08).** An invite or reset link carries a one-use
key in the page address, so the document now tells the site how to keep it
safe: its page must not pass the address on to other servers (the
`Referrer-Policy: no-referrer` header), must load nothing from anyone else
until the link is used, and must wipe the key from the address bar at once.
Two small tidy-ups came with it: a leftover duplicate comment is gone, and
a refusal no longer prints "[object Object]" when sent something odd. The
branch also took in the newest `main`, whose limit of one reset email per
person every 15 minutes needed one test to step its clock forward.
