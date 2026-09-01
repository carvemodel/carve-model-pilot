# September 2, 2026 domain migration

This repository is prepared for the move from the temporary website domain to
the permanent Carve Model domain.

## Prepared in code

- `astro.config.mjs` uses `https://www.physical-model.com` as the canonical site.
- Canonical tags, structured data, the XML sitemap, and `robots.txt` use the
  permanent `www.physical-model.com` hostname.
- `vercel.json` contains explicit HTTP 301 redirects for removed Squarespace
  routes and Search Console-discovered variants.
- Redirect destinations remain relative. This lets the rules be deployed and
  tested without prematurely sending the temporary hostname to the permanent
  domain.
- `npm run validate:redirects` checks the migration redirect inventory.

## Do not activate before the cutover

Do not configure `carvecreation.com` or `www.carvecreation.com` as redirects to
`www.physical-model.com` until the permanent domain is connected, its TLS
certificate is active, and the new site passes acceptance testing.

## Migration-day order

1. Freeze content changes and confirm the latest production deployment is healthy.
2. Run `npm run validate:redirects` and `npm run build`.
3. In the Vercel project, add `physical-model.com` and
   `www.physical-model.com` under **Settings → Domains**.
4. Make `www.physical-model.com` the preferred production hostname and redirect
   the apex `physical-model.com` to it.
5. At GoDaddy, change only the website records requested by Vercel. Preserve
   MX, SPF, DKIM, DMARC, verification, nameserver, and non-web subdomain records.
6. Wait for Vercel to report valid DNS and an active TLS certificate.
7. Test the homepage, forms, Studio Portal links, sitemap, robots file, and all
   rows in the redirect workbook.
8. Confirm each migration source returns HTTP 301 and its final destination
   returns HTTP 200 in one hop.
9. Only after the permanent site passes: edit the Vercel domain settings for
   `carvecreation.com` and `www.carvecreation.com` and redirect both domains to
   `https://www.physical-model.com`. Confirm Vercel preserves the requested path.
10. Submit `https://www.physical-model.com/sitemap-index.xml` in Search Console.
11. Use Search Console Change of Address for `carvecreation.com` to
    `physical-model.com` after the cross-domain redirects are live.

## Acceptance URLs

- `https://www.physical-model.com/` → 200
- `https://physical-model.com/` → permanent redirect to the `www` homepage
- `https://www.physical-model.com/sitemap-index.xml` → 200
- `https://www.physical-model.com/sitemap-0.xml` → 200
- `https://www.physical-model.com/robots.txt` → 200
- Removed Squarespace routes → 301 → matching final page → 200
- `carvecreation.com/{path}` → permanent redirect →
  `www.physical-model.com/{path}` after cutover

Vercel documentation:

- https://vercel.com/docs/project-configuration/vercel-json
- https://vercel.com/docs/domains/working-with-domains/deploying-and-redirecting
