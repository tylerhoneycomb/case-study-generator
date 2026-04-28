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
//
// Returns BOTH the validated Campaign (from campaignData.data) AND the wider
// initialCampaignData blob. Some platform variants put the hero image URL
// in siblings of campaignData (e.g. initialCampaignData.campaignMedia or
// initialCampaignData.media), which the campaign-level deep-scan can't see
// because it only walks campaignData.data. extractHeroImageUrl() falls back
// to the wider blob when the campaign-level search comes up empty.
// ---------------------------------------------------------------------------
export interface FetchedCampaign {
  campaign: Campaign;
  // initialCampaignData object — the parent of campaignData. Carries any
  // sibling fields (campaignMedia, media, images, etc.) that aren't part of
  // the validated Campaign schema. Used only by the image resolver.
  initialCampaignData: unknown;
}

export async function fetchCampaign(slug: string): Promise<FetchedCampaign> {
  if (!slug) throw new ScrapeError('BAD_SLUG', 'fetchCampaign requires a non-empty slug.');
  const html = await fetchHtml(`${BASE_URL}/campaigns/${encodeURIComponent(slug)}`);
  const data = extractNextData(html);

  const initialCampaignData = get<unknown>(data, [
    'props',
    'pageProps',
    'initialCampaignData',
  ]);
  if (!initialCampaignData || typeof initialCampaignData !== 'object') {
    throw new ScrapeError(
      'DETAIL_SHAPE_DRIFT',
      `Detail payload missing at props.pageProps.initialCampaignData for slug "${slug}".`,
    );
  }

  const raw = get<unknown>(initialCampaignData, ['campaignData', 'data']);
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
  return { campaign: parsed.data, initialCampaignData };
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

// ---------------------------------------------------------------------------
// Hero image resolver — finds an image URL in a campaign payload.
//
// The platform's data shape varies by campaign vintage:
//   - v3.3-spec canonical:   campaign.ogImageUrl
//   - newer/variant:         campaign.campaignMedia[].url (or .src/.imageUrl)
//   - some campaigns:        only the rendered <img> URL is reachable, which
//                            usually traces back to a honeycomb-uploads URL
//                            buried elsewhere in __NEXT_DATA__
//
// extractHeroImageUrl() walks all three in priority order. The recursive
// deep-scan fallback is bounded to depth 5 and only matches URLs that look
// like Honeycomb image storage to avoid false positives on social-link URLs.
// ---------------------------------------------------------------------------
const HONEYCOMB_IMAGE_HOST = 'storage.googleapis.com/honeycomb-uploads';
const IMAGE_EXT_RE = /\.(jpg|jpeg|png|webp|gif)(\?|$)/i;

function looksLikeImageUrl(s: string): boolean {
  if (!s.startsWith('http')) return false;
  return IMAGE_EXT_RE.test(s) || s.includes(HONEYCOMB_IMAGE_HOST) || s.includes('campaignMedia');
}

function pickStringField(obj: Record<string, unknown>, keys: ReadonlyArray<string>): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && looksLikeImageUrl(v)) return v;
  }
  return null;
}

// Depth bound for the recursive deep-scan. Honeycomb's __NEXT_DATA__
// nests: campaign → campaignStories[] → paragraphs[] → media → {url|thumb},
// which is depth 7 in the worst case. 8 gives a small safety margin.
function findImageUrlDeep(value: unknown, depth = 0): string | null {
  if (depth > 8) return null;
  if (typeof value === 'string') {
    return looksLikeImageUrl(value) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findImageUrlDeep(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      const hit = findImageUrlDeep(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

export function extractHeroImageUrl(campaign: Campaign, wider?: unknown): string | null {
  // 1. Canonical (v3.3 spec)
  if (campaign.ogImageUrl && looksLikeImageUrl(campaign.ogImageUrl)) {
    return campaign.ogImageUrl;
  }

  // 2. Top-level alternates that show up in some payloads
  const top = campaign as unknown as Record<string, unknown>;
  const direct = pickStringField(top, ['heroImageUrl', 'coverImageUrl', 'mainImageUrl', 'imageUrl', 'image']);
  if (direct) return direct;

  // 3. campaignMedia array — most common newer location
  if (Array.isArray(campaign.campaignMedia)) {
    for (const item of campaign.campaignMedia) {
      if (typeof item === 'string' && looksLikeImageUrl(item)) return item;
      if (item && typeof item === 'object') {
        const hit = pickStringField(item as Record<string, unknown>, ['url', 'imageUrl', 'src', 'href', 'fileUrl']);
        if (hit) return hit;
      }
    }
  }

  // 4. Deep scan within campaignData.data.
  const local = findImageUrlDeep(campaign);
  if (local) return local;

  // 5. Deep scan the wider initialCampaignData blob — siblings to
  //    campaignData (campaignMedia, media, images, etc.) live here for some
  //    platform variants. This is the catch-all that handles every campaign
  //    we've observed where the URL isn't in campaignData.data at all.
  if (wider !== undefined) {
    const widerHit = findImageUrlDeep(wider);
    if (widerHit) return widerHit;
  }

  return null;
}
