## 2026-11-10 — The tracker page's forwarding site answers 404 at its front page: forward / to the tracker too (SP-198)

The forwarding site from #135 is now a real Vercel project,
spirality-tracker-page. Tried at its test address, every page reached the
tracker except the front page, which showed Vercel's own "page not found".
The one forwarding rule covered every path but the bare `/`, so the sign-in
screen people land on never appeared. The site now has a second rule just
for the front page.

Making the project also left two files in the site's folder: Vercel's link
to the project and a short-lived token. Neither was uploaded (both paths
reached the tracker's own "sign in" answer), and git now ignores both. The
token file is not needed and can be deleted.

The name spirality.alphire.agency stays on StarCaster's project until this
is merged, the folder is deployed again and the front page shows the
sign-in screen.
