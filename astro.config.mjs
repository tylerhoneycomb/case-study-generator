import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import tailwind from '@astrojs/tailwind';

// Phase 1: site is the production custom domain. The build is deployed via
// GitHub Pages; the CNAME file in public/ tells Pages which host it serves.
// Until the CNAME is wired up in DNS (Phase 5), the site is also reachable
// at https://tylerhoneycomb.github.io/case-study-generator/.
export default defineConfig({
  site: 'https://funded.honeycombcredit.com',
  trailingSlash: 'never',
  build: {
    format: 'directory',
  },
  integrations: [
    mdx(),
    sitemap({
      // /admin is the operator portal; never index, never include in sitemap.
      // The page itself also carries <meta name="robots" content="noindex">.
      filter: (page) => !page.includes('/admin'),
    }),
    tailwind({ applyBaseStyles: false }),
  ],
});
