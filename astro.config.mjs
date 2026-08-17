// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://www.physical-model.com',
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
        !page.includes('/thank-you'),
    }),
  ],
});
