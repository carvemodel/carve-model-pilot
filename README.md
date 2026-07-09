# Carve Model Website — Astro Rebuild

This is the Carve Model marketing site + Studio Portal, rebuilt from the static
HTML/CSS/JS handoff bundle into a real Astro project — matching the setup used
by the sibling "Carve Modular" project (`npm install && npm run dev`, Astro 5,
plain CSS, `@astrojs/sitemap`).

This is a **lift-and-restructure**, not a redesign: every page's copy, layout,
and interaction logic was carried over unchanged. Only the delivery mechanism
changed — real components, a dev server, and clean URLs.

## Running it

```bash
npm install
npm run dev       # http://localhost:4321
npm run build     # outputs to dist/
npm run preview   # preview the production build
```

## Structure

```
src/
  layouts/
    BaseLayout.astro       # shared <head>, Header, Footer, site.js/image-slot.js
    BlogPostLayout.astro   # shared article shell for the 4 blog posts
  components/
    Header.astro           # site nav, active-state aware
    Footer.astro
  pages/
    index.astro                      → /
    about-carve-model.astro          → /about-carve-model
    scale-model-services.astro       → /scale-model-services
    model-making-process.astro       → /model-making-process
    works.astro                      → /works
    faq.astro                        → /faq
    contact.astro                    → /contact
    blog.astro                       → /blog
    blog/*.astro (4 posts)           → /blog/<slug>
    login.html                       → /login   (plain HTML — see note below)
    app.html                         → /app     (plain HTML — Studio Portal)
    quotation.html                   → /quotation
    factory-sourcing.html            → /factory-sourcing
    photo-markup-review.html         → /photo-markup-review
public/
  styles.css, site.js, image-slot.js   # copied verbatim from the handoff bundle
  _ds_tokens/                          # design token reference CSS (colors/type/spacing/fonts)
  assets/                              # EMPTY — see "Missing assets" below
api/
  sourcing.js   # Vercel serverless function — shared leads/briefs store (Redis)
  upload.js     # Vercel serverless function — file uploads (Vercel Blob)
```

### Why some pages are plain `.html`

`login.html`, `app.html`, `quotation.html`, `factory-sourcing.html`, and
`photo-markup-review.html` are dropped into `src/pages/` as **plain HTML
files**, not `.astro` components. Astro serves `.html` files in `src/pages/`
as-is, with zero processing — no script bundling, no scoping. These pages are
heavy, self-contained vanilla-JS tools (the Studio Portal and its sub-tools)
that rely on classic global-scope scripts and inline `onclick="..."` handlers
throughout. Converting them to `.astro` would have caused Astro to bundle
their `<script>` blocks as ES modules by default, silently breaking every
`onclick` handler. Keeping them as `.html` preserves their behavior exactly,
per the handoff brief.

The marketing pages (home, about, services, etc.) *are* `.astro` components,
sharing `BaseLayout`/`Header`/`Footer` — these had simpler, more contained
scripts, so each inline `<script>` was marked `is:inline` to keep it a classic
global script (verified in the production build: `filterWorks`, the contact
wizard, and the Firebase compat scripts all still load as plain scripts, not
modules).

### URL changes (intentional)

Route paths now match the **canonical URLs** already declared in each page's
`<link rel="canonical">` (e.g. `about.html` → `/about-carve-model`,
`services.html` → `/scale-model-services`, `process.html` →
`/model-making-process`). This preserves existing SEO equity for when this
replaces the live physical-model.com site — the canonical URLs don't change,
only the old `.html` filenames do. All internal links/footer/nav were updated
to match.

## Missing assets (not in the handoff bundle)

The handoff bundle referenced but did not include actual image files. Before
launch, `public/assets/` needs:

- Logo: `logo-lockup.png`, `logo-mark.png` (favicon), and any trimmed/black-bg variants
- Client logos: `client-gensler.png`, `client-populous.jpeg`, `client-turner.png`
- All `<image-slot>` placeholders across the site (hero, works, services, blog covers) currently show empty drop targets — real photography needs to be sourced and swapped in (the original handoff flagged project photography as hot-linked from a Squarespace CDN that should be replaced with local hi-res copies)
- `og-home.jpg`, `logo-full.png` referenced in Open Graph / JSON-LD tags

## Environment variables (for `/api`)

The two serverless functions need these Vercel-provided env vars (already
configured on the live Vercel project — just carry them over):

- `REDIS_URL` — Upstash Redis (`carve-sourcing-kv`), used by `api/sourcing.js`
- `BLOB_READ_WRITE_TOKEN` — Vercel Blob (`carve-model-pilot-blob`), used by `api/upload.js`

The contact form's Firebase config (`carve-model-pilot` project) is a
client-side public API key, carried over unchanged from the original — this
is normal for Firebase and was already public in the live source.

## Deploying

Same as the sibling Astro project: push to GitHub, import into Vercel. The
`/api` folder is picked up automatically as serverless functions alongside the
static Astro output — no adapter needed.
