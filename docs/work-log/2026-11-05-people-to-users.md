## 2026-11-05 — Enhanced user management (#114)

The first step of Dane's user-management series: the tracker page's
**People** section is now called **Users**. The header link, the page's
heading, its breadcrumb and its browser-tab title all say Users, and the
page has a new address, `/users`.

Old bookmarks still work: a browser that opens `/people` is sent straight
on to `/users`. That hand-off is deliberately never remembered by the
browser, because the page itself still fetches its list of users from
`/people` behind the scenes (so do the setup scripts for a new project),
and a remembered hand-off would have caught those fetches too and broken
the page. Inviting someone and cancelling an invite work exactly as before.

This clears the way for the next slices: roles and permissions, then which
users belong to which project.
