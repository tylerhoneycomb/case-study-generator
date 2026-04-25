import {
  HoneycombListingEntry,
  HoneycombCampaignPayload,
  HoneycombCampaignData,
} from './types';

const LISTING_URL = 'https://invest.honeycombcredit.com/';
const CAMPAIGN_URL = (slug: string) =>
  `https://invest.honeycombcredit.com/campaigns/${encodeURIComponent(slug)}`;

const NEXT_DATA_RE =
  /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;

export class ScrapeError extends Error {
  constructor(message: string, readonly url: string) {
    super(`[scrape ${url}] ${message}`);
    this.name = 'ScrapeError';
  }
}

async function fetchNextData(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      'user-agent':
        'honeycomb-collateral-agent/1.0 (+https://github.com/tylerhoneycomb/case-study-generator)',
      accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) throw new ScrapeError(`HTTP ${res.status}`, url);
  const html = await res.text();
  const m = NEXT_DATA_RE.exec(html);
  if (!m) throw new ScrapeError('__NEXT_DATA__ script tag not found', url);
  try {
    return JSON.parse(m[1]);
  } catch (err) {
    throw new ScrapeError(`__NEXT_DATA__ JSON parse failure: ${(err as Error).message}`, url);
  }
}

function getProp<T = unknown>(obj: unknown, path: string[]): T | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur && typeof cur === 'object' && key in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur as T;
}

export async function fetchListing(): Promise<HoneycombListingEntry[]> {
  const data = await fetchNextData(LISTING_URL);
  const entries = getProp<unknown[]>(data, [
    'props',
    'pageProps',
    'data',
    'data',
  ]);
  if (!Array.isArray(entries)) {
    throw new ScrapeError(
      'props.pageProps.data.data was not an array',
      LISTING_URL,
    );
  }
  return entries.map((raw, i) => coerceListingEntry(raw, i));
}

function coerceListingEntry(raw: unknown, index: number): HoneycombListingEntry {
  const r = raw as Record<string, unknown>;
  const slug = r.slug;
  if (typeof slug !== 'string' || !slug) {
    throw new ScrapeError(
      `listing entry ${index} missing slug`,
      LISTING_URL,
    );
  }
  return {
    slug,
    campaignId: String(r.campaignId ?? ''),
    campaignName: String(r.campaignName ?? ''),
    campaignStage: String(r.campaignStage ?? ''),
    campaignStartDate: String(r.campaignStartDate ?? ''),
    campaignExpirationDate: String(r.campaignExpirationDate ?? ''),
    campaignTargetAmount: Number(r.campaignTargetAmount ?? 0),
    campaignMinimumAmount: Number(r.campaignMinimumAmount ?? 0),
    investmentType: String(r.investmentType ?? ''),
  };
}

export async function fetchCampaign(slug: string): Promise<HoneycombCampaignPayload> {
  const url = CAMPAIGN_URL(slug);
  const data = await fetchNextData(url);

  const campaignData = getProp<HoneycombCampaignData>(data, [
    'props',
    'pageProps',
    'initialCampaignData',
    'campaignData',
    'data',
  ]);
  if (!campaignData || typeof campaignData !== 'object') {
    throw new ScrapeError(
      'props.pageProps.initialCampaignData.campaignData.data missing',
      url,
    );
  }
  if (typeof (campaignData as HoneycombCampaignData).campaignStage !== 'string') {
    throw new ScrapeError('campaignData.campaignStage missing or non-string', url);
  }

  // ogImageUrl is a sibling of initialCampaignData on pageProps
  // (correction to spec v3.3 § 3b — confirmed by sample payloads).
  const ogImageUrl = getProp<string>(data, ['props', 'pageProps', 'ogImageUrl']) ?? null;

  return { campaignData, ogImageUrl };
}
