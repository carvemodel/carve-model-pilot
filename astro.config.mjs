// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://www.physical-model.com',
  build: {
    // Inline Astro's own per-page/component scoped CSS bundles (e.g. the
    // homepage hero's <style> block) directly into each page instead of
    // extracting them to a separate linked .css file -- avoids an extra
    // render-blocking request for critical above-the-fold styles.
    inlineStylesheets: 'always',
  },
  integrations: [
    sitemap({
      // RSS feed, /login, and the studio-portal tool pages aren't content
      // pages and shouldn't appear in the XML sitemap.
      filter: (page) =>
        !page.endsWith('/rss.xml') &&
        !page.includes('/login') &&
        !page.includes('/app') &&
        !page.includes('/quotation') &&
        !page.includes('/factory-sourcing') &&
        !page.includes('/photo-markup-review') &&
        !page.includes('/admin-works') &&
        !page.includes('/thank-you'),
      // Astro's static build emits directory-style output (page/index.html),
      // which @astrojs/sitemap reflects as a trailing-slash URL by default.
      // BaseLayout's canonical tags are non-trailing-slash (see
      // src/layouts/BaseLayout.astro), so strip the trailing slash here to
      // keep every sitemap entry matching its page's own canonical exactly —
      // except the homepage, which is canonically "/" either way.
      serialize(item) {
        const url = new URL(item.url);
        if (url.pathname !== '/' && url.pathname.endsWith('/')) {
          url.pathname = url.pathname.slice(0, -1);
        }
        item.url = url.toString();
        return item;
      },
    }),
  ],
});
