#!/usr/bin/env tsx
// =============================================================================
// scripts/inspect.ts <slug> [--issue=N]
//
// Diagnostic: fetch a Honeycomb campaign page and report what's in it. No
// API spend, no commits, no MDX writes. The tool that prevents the next
// five-round saga: hands you ground truth on
//   - HTML / __NEXT_DATA__ payload size
//   - Every URL that appears anywhere in __NEXT_DATA__ (deduped)
//   - The canonical pageProps.ogImageUrl, if set
//   - The first <img> the SSR'd HTML renders (whatever the resolver would
//     fall back to if the JSON-side paths failed)
//   - Top-level keys at props.pageProps and at initialCampaignData
//
// Invoked by /funded inspect <slug>.
// =============================================================================

import { parseArgs, requirePositional } from './lib/args.js';
import { setTrackingIssue, info, error as logError, stage } from './lib/log.js';
import { fetchCampaign } from './lib/scrape.js';

function dedupedUrls(blob: unknown): string[] {
  const seen = new Set<string>();
  const re = /https?:\/\/[^\s"'<>]+/g;
  const text = JSON.stringify(blob);
  const matches = text.match(re) ?? [];
  for (const m of matches) seen.add(m);
  return Array.from(seen).sort();
}

function topLevelKeys(blob: unknown): string[] {
  if (!blob || typeof blob !== 'object') return [];
  return Object.keys(blob as Record<string, unknown>).sort();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const slug = requirePositional(args, 0, '<slug>');
  const issueRaw = args.values['issue'];
  const issueNumber = issueRaw ? Number.parseInt(issueRaw, 10) : null;
  if (issueNumber !== null && !Number.isNaN(issueNumber)) {
    setTrackingIssue(issueNumber);
  }

  info('inspect start', { slug });

  let fetched;
  try {
    fetched = await fetchCampaign(slug);
  } catch (err) {
    await stage(`❌ Inspect failed: ${(err as Error).message}`);
    process.exit(1);
  }

  const { campaign, pageProps, html } = fetched;
  const ppRecord = pageProps && typeof pageProps === 'object'
    ? pageProps as Record<string, unknown>
    : {};
  const initialCampaignData = ppRecord['initialCampaignData'];
  const renderedImg = html.match(
    /<img[^>]+src=["']([^"']+)["']/i,
  );

  const urls = dedupedUrls(pageProps);
  const honeycombUrls = urls.filter((u) =>
    u.includes('storage.googleapis.com/honeycomb-uploads') || u.includes('campaignMedia'),
  );

  const report = [
    `### Inspect: \`${slug}\``,
    '',
    `- HTML body: **${html.length.toLocaleString()} bytes**`,
    `- pageProps top-level keys: ${topLevelKeys(pageProps).map((k) => `\`${k}\``).join(', ') || '(none)'}`,
    `- initialCampaignData top-level keys: ${topLevelKeys(initialCampaignData).map((k) => `\`${k}\``).join(', ') || '(none)'}`,
    `- campaign.campaignStage: \`${campaign.campaignStage ?? '(unset)'}\``,
    `- campaign.ogImageUrl: \`${campaign.ogImageUrl ?? '(unset)'}\``,
    `- pageProps.ogImageUrl: \`${typeof ppRecord['ogImageUrl'] === 'string' ? ppRecord['ogImageUrl'] : '(unset)'}\``,
    `- First rendered <img src>: \`${renderedImg?.[1] ?? '(none)'}\``,
    '',
    `**Honeycomb-shaped URLs in pageProps (${honeycombUrls.length})**`,
    honeycombUrls.length === 0 ? '_none_' : honeycombUrls.map((u) => `- ${u}`).join('\n'),
    '',
    `**All URLs in pageProps (${urls.length})**`,
    urls.length === 0 ? '_none_' : urls.slice(0, 30).map((u) => `- ${u}`).join('\n'),
    urls.length > 30 ? `\n_…and ${urls.length - 30} more_` : '',
  ].join('\n');

  await stage(report);
}

main().catch((err: unknown) => {
  logError('inspect crashed', { message: (err as Error).message });
  process.exit(1);
});
