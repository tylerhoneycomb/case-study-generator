import {
  GeneratedCaseStudy,
  HoneycombCampaignData,
  WixCaseStudyItem,
  WixInsertResult,
} from './types';

const COLLECTION_ID = 'CaseStudies';
const STATIC_CTA_URL = 'https://honeycombcredit.com/pre-qualify';
const CAMPAIGN_URL_BASE = 'https://invest.honeycombcredit.com/campaigns/';

export class WixError extends Error {
  constructor(message: string, readonly stage: string) {
    super(`[wix:${stage}] ${message}`);
    this.name = 'WixError';
  }
}

interface WixAuth {
  apiKey: string;
  siteId: string;
}

function authHeaders(auth: WixAuth): Record<string, string> {
  return {
    Authorization: auth.apiKey,
    'wix-site-id': auth.siteId,
  };
}

// ---------- formatters ----------

export function formatCurrency(n: number): string {
  const rounded = Math.round(n);
  return '$' + rounded.toLocaleString('en-US');
}

export function formatPercent(raised: number, goal: number): string {
  if (!goal || goal <= 0) return '0%';
  return Math.round((raised / goal) * 100) + '%';
}

export function percentNumber(raised: number, goal: number): number {
  if (!goal || goal <= 0) return 0;
  return Math.round((raised / goal) * 100);
}

export function formatTimeToFund(startDate: string, endDate: string): string {
  const start = Date.parse(startDate);
  const end = Date.parse(endDate);
  if (Number.isNaN(start) || Number.isNaN(end)) return '';
  const days = Math.max(1, Math.round((end - start) / 86400000));
  return `${days} day${days === 1 ? '' : 's'}`;
}

// ---------- Wix Media: hero image upload ----------

export async function uploadHeroImage(
  ogImageUrl: string,
  auth: WixAuth,
): Promise<string> {
  const imageRes = await fetch(ogImageUrl);
  if (!imageRes.ok) {
    throw new WixError(`source image fetch HTTP ${imageRes.status}`, 'media-fetch');
  }
  const buf = Buffer.from(await imageRes.arrayBuffer());
  const mime = imageRes.headers.get('content-type') || 'image/jpeg';
  const ext = mime.includes('png') ? 'png' : 'jpg';
  const filename = `hero-${Date.now()}.${ext}`;

  const genRes = await fetch(
    'https://www.wixapis.com/site-media/v1/files/generate-upload-url',
    {
      method: 'POST',
      headers: { ...authHeaders(auth), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mimeType: mime,
        fileName: filename,
        parentFolderId: 'media-root',
      }),
    },
  );
  if (!genRes.ok) {
    throw new WixError(
      `generate-upload-url HTTP ${genRes.status}: ${await genRes.text()}`,
      'media-generate',
    );
  }
  const genJson = (await genRes.json()) as { uploadUrl?: string };
  if (!genJson.uploadUrl) {
    throw new WixError('generate-upload-url missing uploadUrl', 'media-generate');
  }

  const putRes = await fetch(genJson.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mime },
    body: buf,
  });
  if (!putRes.ok) {
    throw new WixError(
      `upload PUT HTTP ${putRes.status}: ${await putRes.text()}`,
      'media-upload',
    );
  }
  const putJson = (await putRes.json()) as {
    file?: { url?: string; fileUrl?: string };
  };
  const url = putJson.file?.url || putJson.file?.fileUrl;
  if (!url) {
    throw new WixError('upload response missing file url', 'media-upload');
  }
  return url;
}

// ---------- Wix Data: case-study item ----------

export function buildWixItem(
  generated: GeneratedCaseStudy,
  campaign: HoneycombCampaignData,
  todayISO: string,
  heroMediaUrl: string,
): WixCaseStudyItem {
  const raised = Number(campaign.totalFundsRaised ?? 0);
  const goal = Number(campaign.campaignTargetAmount ?? 0);
  return {
    businessName: campaign.campaignName ?? '',
    slug: generated.slug,
    niche: generated.niche,
    industry: generated.industry,
    city: campaign.issuer?.city ?? '',
    state: campaign.issuer?.state ?? '',
    h1Heading: generated.h1Heading,
    heroSubhead: generated.heroSubhead,
    storyHeading: generated.storyHeading,
    story: generated.story,
    heroImageAlt: generated.heroImageAlt,
    quote: '',
    quoteAttribution: '',
    heroImage: heroMediaUrl,
    amountRaised: raised,
    amountRaisedFormatted: formatCurrency(raised),
    goalAmount: goal,
    goalAmountFormatted: formatCurrency(goal),
    percentOfGoal: percentNumber(raised, goal),
    percentOfGoalFormatted: formatPercent(raised, goal),
    investorCount: Number(campaign.numInvestors ?? 0),
    timeToFund: formatTimeToFund(
      campaign.campaignStartDate,
      campaign.campaignExpirationDate,
    ),
    metaTitle: generated.metaTitle,
    metaDescription: generated.metaDescription,
    ogTitle: generated.ogTitle,
    ogDescription: generated.ogDescription,
    ogImage: heroMediaUrl,
    // canonicalOverride intentionally omitted — Wix URL field rejects empty
    // strings. Reviewer can populate it manually in CMS if a canonical
    // override is ever needed.
    ctaText: generated.ctaText,
    ctaUrl: STATIC_CTA_URL,
    campaignUrl: CAMPAIGN_URL_BASE + (campaign.slug ?? ''),
    publishedDate: todayISO,
    status: 'draft',
    systemSchemaJson: generated.systemSchemaJson,
    campaignId: campaign.campaignId ?? '',
    campaignSlug: campaign.slug ?? '',
  };
}

export async function insertCaseStudy(
  item: WixCaseStudyItem,
  auth: WixAuth,
): Promise<WixInsertResult> {
  const insertRes = await fetch('https://www.wixapis.com/wix-data/v2/items', {
    method: 'POST',
    headers: { ...authHeaders(auth), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dataCollectionId: COLLECTION_ID,
      dataItem: { data: item },
    }),
  });
  if (!insertRes.ok) {
    throw new WixError(
      `insert HTTP ${insertRes.status}: ${await insertRes.text()}`,
      'data-insert',
    );
  }
  const insertJson = (await insertRes.json()) as {
    dataItem?: { _id?: string; id?: string };
  };
  const id = insertJson.dataItem?._id || insertJson.dataItem?.id;
  if (!id) {
    throw new WixError('insert response missing item id', 'data-insert');
  }

  // Re-fetch to read the beforeInsert hook's verdict.
  const getUrl = `https://www.wixapis.com/wix-data/v2/items/${encodeURIComponent(
    id,
  )}?dataCollectionId=${COLLECTION_ID}`;
  const getRes = await fetch(getUrl, { headers: authHeaders(auth) });
  if (!getRes.ok) {
    throw new WixError(
      `post-insert fetch HTTP ${getRes.status}: ${await getRes.text()}`,
      'data-fetch',
    );
  }
  const getJson = (await getRes.json()) as {
    dataItem?: { data?: Record<string, unknown> };
  };
  const data = getJson.dataItem?.data ?? {};
  return {
    _id: id,
    humanizationChecked: Boolean(data.humanizationChecked),
    humanizationIssues:
      typeof data.humanizationIssues === 'string'
        ? (data.humanizationIssues as string)
        : null,
  };
}

export async function findItemBySlug(
  slug: string,
  auth: WixAuth,
): Promise<string | null> {
  const res = await fetch('https://www.wixapis.com/wix-data/v2/items/query', {
    method: 'POST',
    headers: { ...authHeaders(auth), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dataCollectionId: COLLECTION_ID,
      query: {
        filter: { slug: { $eq: slug } },
        paging: { limit: 1 },
      },
    }),
  });
  if (!res.ok) {
    throw new WixError(
      `query HTTP ${res.status}: ${await res.text()}`,
      'data-query',
    );
  }
  const json = (await res.json()) as {
    dataItems?: Array<{ _id?: string; id?: string }>;
  };
  const first = json.dataItems?.[0];
  return first ? first._id || first.id || null : null;
}

export async function updateCaseStudy(
  itemId: string,
  item: WixCaseStudyItem,
  auth: WixAuth,
): Promise<WixInsertResult> {
  const updateRes = await fetch(
    `https://www.wixapis.com/wix-data/v2/items/${encodeURIComponent(itemId)}`,
    {
      method: 'PUT',
      headers: { ...authHeaders(auth), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dataCollectionId: COLLECTION_ID,
        dataItem: { data: { ...item, _id: itemId } },
      }),
    },
  );
  if (!updateRes.ok) {
    throw new WixError(
      `update HTTP ${updateRes.status}: ${await updateRes.text()}`,
      'data-update',
    );
  }

  const getUrl = `https://www.wixapis.com/wix-data/v2/items/${encodeURIComponent(
    itemId,
  )}?dataCollectionId=${COLLECTION_ID}`;
  const getRes = await fetch(getUrl, { headers: authHeaders(auth) });
  if (!getRes.ok) {
    throw new WixError(
      `post-update fetch HTTP ${getRes.status}: ${await getRes.text()}`,
      'data-fetch',
    );
  }
  const getJson = (await getRes.json()) as {
    dataItem?: { data?: Record<string, unknown> };
  };
  const data = getJson.dataItem?.data ?? {};
  return {
    _id: itemId,
    humanizationChecked: Boolean(data.humanizationChecked),
    humanizationIssues:
      typeof data.humanizationIssues === 'string'
        ? (data.humanizationIssues as string)
        : null,
  };
}
