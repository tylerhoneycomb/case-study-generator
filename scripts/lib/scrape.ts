// =============================================================================
// invest.honeycombcredit.com scraper.
//
// The "API" is the __NEXT_DATA__ JSON blob embedded in every page's HTML.
// Two surfaces:
//   - listListing()       → ~10 active Fundraising campaigns
//   - fetchCampaign(slug) → full payload for a single campaign
//
// Every behavior of this module is governed by what the Next.js app chooses
// to render server-side. There is no contract. The defense is twofold:
// defensive parsing here, and the daily-detection cron (scripts/detect.ts)
// always emits a tracking issue so silent failures become visible.
// =============================================================================

import { CampaignSchema, ListingEntrySchema, type Campaign, type ListingEntry } from './schemas.js';

const BASE_URL = 'https://invest.honeycombcredit.com';
const USER_AGENT =
  'Mozilla/5.0 (compatible; HoneycombFundedAgent/4.0; +https://funded.honeycombcredit.com)';

// Carve __NEXT_DATA__ out of an HTML string. Returns the parsed JSON.
function extractNextData(html: string): unknown {
  // Match the script tag verbatim. Next.js always emits this exact id+type.
  const match = html.match(
    /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!match || !match[1]) {
    throw new ScrapeError('NEXT_DATA_NOT_FOUND', 'No __NEXT_DATA__ script found in HTML.');
  }
  try {
    return JSON.parse(match[1]) as unknown;
  } catch (err) {
    throw new ScrapeError(
      'NEXT_DATA_PARSE_FAILED',
      `__NEXT_DATA__ found but JSON.parse failed: ${(err as Error).message}`,
    );
  }
}

// Drill into a deeply-nested path with safe optional chaining.
function get<T = unknown>(root: unknown, path: ReadonlyArray<string>): T | undefined {
  let cursor: unknown = root;
  for (const key of path) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor as T | undefined;
}

export class ScrapeError extends Error {
  constructor(public override readonly name: string, message: string) {
    super(message);
  }
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) {
    throw new ScrapeError(
      'HTTP_ERROR',
      `GET ${url} returned ${res.status} ${res.statusText}`,
    );
  }
  return res.text();
}

// ---------------------------------------------------------------------------
// Listing — only surfaces ~10 currently-active Fundraising campaigns.
// The `?page=N` parameter is not respected server-side; do not bother paging.
// ---------------------------------------------------------------------------
export async function listListing(): Promise<ListingEntry[]> {
  const html = await fetchHtml(`${BASE_URL}/`);
  const data = extractNextData(html);

  // Path: __NEXT_DATA__.props.pageProps.data.data
  const raw = get<unknown>(data, ['props', 'pageProps', 'data', 'data']);
  if (!Array.isArray(raw)) {
    throw new ScrapeError(
      'LISTING_SHAPE_DRIFT',
      'Listing payload is not an array at props.pageProps.data.data.',
    );
  }

  const out: ListingEntry[] = [];
  for (const item of raw) {
    const parsed = ListingEntrySchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
    // Skip items that don't validate; they're typically incomplete records
    // the platform hasn't finished provisioning.
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detail page — full campaign payload by slug.
// ---------------------------------------------------------------------------
export async function fetchCampaign(slug: string): Promise<Campaign> {
  if (!slug) throw new ScrapeError('BAD_SLUG', 'fetchCampaign requires a non-empty slug.');
  const html = await fetchHtml(`${BASE_URL}/campaigns/${encodeURIComponent(slug)}`);
  const data = extractNextData(html);

  const raw = get<unknown>(data, [
    'props',
    'pageProps',
    'initialCampaignData',
    'campaignData',
    'data',
  ]);
  if (!raw || typeof raw !== 'object') {
    throw new ScrapeError(
      'DETAIL_SHAPE_DRIFT',
      `Detail payload missing at props.pageProps.initialCampaignData.campaignData.data for slug "${slug}".`,
    );
  }

  const parsed = CampaignSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ScrapeError(
      'DETAIL_VALIDATION_FAILED',
      `Detail payload failed schema validation for slug "${slug}": ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Public URL helpers
// ---------------------------------------------------------------------------
export function campaignUrl(slug: string): string {
  return `${BASE_URL}/campaigns/${slug}`;
}

export function isFunded(stage: string): boolean {
  return stage.trim().toLowerCase() === 'funded';
}

export function isFundraising(stage: string): boolean {
  return stage.trim().toLowerCase() === 'fundraising';
}

// Stages where the campaign has hit its goal and the story is complete.
// "Funded" is the canonical final state; "Successful - Finalizing" is the
// post-close paperwork window before a campaign formally flips to Funded.
// Both should trigger case-study generation — the narrative doesn't change
// while disbursement docs are in flight, and waiting just delays the page.
//
// Add new states here as they're observed in the wild. The case-insensitive
// match defends against minor casing drift in the upstream platform.
const SUCCESSFUL_STAGES = new Set([
  'funded',
  'successful - finalizing',
]);

export function isCampaignSuccessful(stage: string): boolean {
  return SUCCESSFUL_STAGES.has(stage.trim().toLowerCase());
}
