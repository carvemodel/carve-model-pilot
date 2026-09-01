import { next } from '@vercel/functions';

// The old (pre-migration) site occasionally appended its own hostname as an
// empty-value query parameter to internal links/redirects -- e.g.
// "/architectural-scale-models?www.physical-model.com=" or
// "/contact?www.physical-model.com=" -- which GA4 then recorded as distinct
// landing pages. Nothing in this codebase generates that parameter: the nav
// links in Header.astro/Footer.astro are plain relative paths, and every
// vercel.json redirect destination is a clean "/..." path with no domain
// baked into it. So this middleware is purely a safety net for old
// bookmarks, indexed search results, and external backlinks that still
// carry the malformed parameter -- it strips ONLY that one self-referencing
// domain key. gclid and every utm_* parameter (and anything else) pass
// through completely untouched, so Google Ads attribution keeps working.
// See the "Fix the malformed landing-page variants" tracking request.
const SELF_REFERENCING_DOMAIN_KEYS = [
  'physical-model.com',
  'www.physical-model.com',
  'carvecreation.com',
  'www.carvecreation.com'
];

export const config = {
  // Run on every page request except /api/* and any path ending in a file
  // extension (images, CSS, JS, fonts, favicon, robots.txt, sitemap files,
  // etc.) -- those never carry landing-page query params worth checking.
  matcher: ['/((?!api/)(?!.*\\.[a-zA-Z0-9]+$).*)']
};

export default function middleware(request) {
  const url = new URL(request.url);

  const keys = new Set(SELF_REFERENCING_DOMAIN_KEYS);
  keys.add(url.hostname);

  let matched = false;
  for (const key of keys) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      matched = true;
    }
  }

  if (!matched) return next();

  return Response.redirect(url, 301);
}
