import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';

export async function GET(context) {
  const all = await getCollection('case-studies', ({ id }) => !id.startsWith('_'));
  const items = all
    .slice()
    .sort((a, b) => b.data.publishedDate.getTime() - a.data.publishedDate.getTime())
    .map((entry) => ({
      title: entry.data.h1Heading,
      pubDate: entry.data.publishedDate,
      description: entry.data.metaDescription,
      link: `/${entry.slug}`,
      categories: [entry.data.industry, entry.data.niche],
    }));

  return rss({
    title: 'Funded — Honeycomb Credit case studies',
    description:
      'Stories of small businesses that raised capital from their communities through Honeycomb Credit.',
    site: context.site ?? 'https://funded.honeycombcredit.com',
    items,
  });
}
