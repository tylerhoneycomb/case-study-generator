import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import tailwind from '@astrojs/tailwind';

// Production custom domain, live. The build is deployed via GitHub Pages;
// the CNAME file in public/ tells Pages which host it serves.
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
