/**
 * The forwarding site that puts an https name of our own (trackerPageUrl,
 * e.g. spirality.alphire.agency) in front of the tracker (SP-164).
 *
 * WHY A FORWARDER. The tracker is on the internet through Tailscale Funnel
 * at `trackerPublicUrl`, but Funnel's certificate is for its own ts.net name,
 * so another name cannot simply point at it: something has to take the
 * request under the new name and pass it on. The smallest standard way is a
 * Vercel project whose only content is its rewrites: every path, as it is, to
 * `trackerPublicUrl`. The front page needs a rule of its own (SP-198):
 * `/:path*` does not match the bare `/` on Vercel, which answered its own 404
 * there instead of the tracker's sign-in screen. Vercel holds the certificate for the name; the tracker
 * keeps doing everything else (sign-in, roles, the page), and because every
 * address in the page is root-relative and the session cookie names no
 * Domain, the browser keeps the cookie for the name it opened.
 *
 * The site is a single file, `sites/tracker-page/vercel.json`, and it is
 * MADE, never written by hand (CLAUDE.md, engineering rule 2): the
 * destination comes from the project config. `npm run check:tracker-page`
 * (part of `verify`) fails when the file and the config disagree.
 * Nothing else goes in that folder: a file there would be served by Vercel
 * in place of the tracker's own answer at that path. (`vercel link` writes
 * `.vercel/` and `.env.local` there; git ignores both and the CLI does not
 * upload them.)
 */

/** Where the site's one file lives, from the repository's root. */
export const SITE_FILE = 'sites/tracker-page/vercel.json';

/**
 * The site's vercel.json for a project config, as the exact text written to
 * disk. Throws when the config has no `trackerPublicUrl`: with nothing to
 * forward to there is no site.
 */
export function trackerPageSite(config) {
  const target = config?.trackerPublicUrl;
  if (!target) throw new Error('the project config sets no "trackerPublicUrl", so there is nothing for the page\'s name to forward to.');
  const origin = new URL(target).origin;
  const site = {
    rewrites: [
      { source: '/', destination: `${origin}/` },
      { source: '/:path*', destination: `${origin}/:path*` },
    ],
  };
  return `${JSON.stringify(site, null, 2)}\n`;
}

/**
 * Whether the file on disk is what the config makes: `{ ok, why }`. With no
 * `trackerPublicUrl` there should be no file; with one, the file must match
 * byte for byte.
 */
export function checkTrackerPageSite(config, onDisk) {
  if (!config?.trackerPublicUrl) {
    return onDisk == null
      ? { ok: true, why: 'no trackerPublicUrl and no site: nothing to forward.' }
      : { ok: false, why: `${SITE_FILE} exists but the project config sets no "trackerPublicUrl"; remove it or set the address.` };
  }
  const want = trackerPageSite(config);
  if (onDisk == null) return { ok: false, why: `${SITE_FILE} is missing; make it with: node scripts/tracker_page_site.mjs` };
  if (onDisk !== want) return { ok: false, why: `${SITE_FILE} does not match the project config's "trackerPublicUrl"; remake it with: node scripts/tracker_page_site.mjs` };
  return { ok: true, why: `${SITE_FILE} forwards every path to ${new URL(config.trackerPublicUrl).origin}.` };
}
