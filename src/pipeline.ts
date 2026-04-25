import {
  CampaignReport,
  HoneycombCampaignPayload,
  WixCaseStudyItem,
} from './types';
import { fetchCampaign, ScrapeError } from './scraper';
import { buildPromptInput, generateCaseStudy, GenerationError } from './generator';
import {
  uploadHeroImage,
  buildWixItem,
  insertCaseStudy,
  findItemBySlug,
  updateCaseStudy,
  WixError,
} from './wix';

const PUBLIC_BASE = 'https://honeycombcredit.com/case-studies/';

export type PipelineMode = 'create' | 'rebuild';

export interface PipelineDeps {
  anthropicKey: string;
  wixAuth: { apiKey: string; siteId: string };
  todayISO: string;
}

export interface PipelineSuccess {
  ok: true;
  report: CampaignReport;
  mode: PipelineMode;
}

export interface PipelineSkip {
  ok: false;
  reason: 'already-exists' | 'not-found' | 'no-hero-image' | 'no-payload';
  message: string;
}

export type PipelineOutcome = PipelineSuccess | PipelineSkip;

function wixCmsLink(siteId: string, itemId: string): string {
  return `https://manage.wix.com/dashboard/${siteId}/database/data/CaseStudies/${itemId}`;
}

function buildCampaignReport(
  slug: string,
  wixItem: WixCaseStudyItem,
  result: { _id: string; humanizationChecked: boolean; humanizationIssues: string | null },
  siteId: string,
): CampaignReport {
  return {
    slug,
    businessName: wixItem.businessName,
    industry: wixItem.industry,
    niche: wixItem.niche,
    amountRaisedFormatted: wixItem.amountRaisedFormatted,
    investorCount: wixItem.investorCount,
    wixItemId: result._id,
    wixCmsUrl: wixCmsLink(siteId, result._id),
    publicPreviewUrl: PUBLIC_BASE + wixItem.slug,
    humanizationChecked: result.humanizationChecked,
    humanizationIssues: result.humanizationIssues,
  };
}

async function fetchAndGenerate(
  slug: string,
  deps: PipelineDeps,
): Promise<{
  payload: HoneycombCampaignPayload;
  wixItem: WixCaseStudyItem;
} | PipelineSkip> {
  const payload = await fetchCampaign(slug);
  if (!payload || !payload.campaignData) {
    return { ok: false, reason: 'no-payload', message: `${slug}: campaign payload empty` };
  }
  if (!payload.ogImageUrl) {
    return { ok: false, reason: 'no-hero-image', message: `${slug}: ogImageUrl missing` };
  }

  const input = buildPromptInput(payload.campaignData, deps.todayISO);
  const generated = await generateCaseStudy(input, deps.anthropicKey);
  const heroMediaUrl = await uploadHeroImage(payload.ogImageUrl, deps.wixAuth);
  const wixItem = buildWixItem(generated, payload.campaignData, deps.todayISO, heroMediaUrl);
  return { payload, wixItem };
}

export async function processSlugCreate(
  slug: string,
  deps: PipelineDeps,
): Promise<PipelineOutcome> {
  const existing = await findItemBySlug(slug, deps.wixAuth);
  if (existing) {
    return {
      ok: false,
      reason: 'already-exists',
      message: `${slug}: CMS item already exists (${existing}); use rebuild`,
    };
  }
  const built = await fetchAndGenerate(slug, deps);
  if ('ok' in built && built.ok === false) return built;
  const { wixItem } = built as { wixItem: WixCaseStudyItem };
  const result = await insertCaseStudy(wixItem, deps.wixAuth);
  return {
    ok: true,
    mode: 'create',
    report: buildCampaignReport(slug, wixItem, result, deps.wixAuth.siteId),
  };
}

export async function processSlugRebuild(
  slug: string,
  deps: PipelineDeps,
): Promise<PipelineOutcome> {
  const existingId = await findItemBySlug(slug, deps.wixAuth);
  if (!existingId) {
    return {
      ok: false,
      reason: 'not-found',
      message: `${slug}: no existing CMS item to rebuild`,
    };
  }
  const built = await fetchAndGenerate(slug, deps);
  if ('ok' in built && built.ok === false) return built;
  const { wixItem } = built as { wixItem: WixCaseStudyItem };
  const result = await updateCaseStudy(existingId, wixItem, deps.wixAuth);
  return {
    ok: true,
    mode: 'rebuild',
    report: buildCampaignReport(slug, wixItem, result, deps.wixAuth.siteId),
  };
}

export function classifyError(err: unknown): {
  stage: 'scrape' | 'generate' | 'upload' | 'insert' | 'unknown';
  message: string;
} {
  if (err instanceof ScrapeError) return { stage: 'scrape', message: err.message };
  if (err instanceof GenerationError) return { stage: 'generate', message: err.message };
  if (err instanceof WixError) {
    const stage =
      err.stage.startsWith('media') ? 'upload'
      : err.stage.startsWith('data') ? 'insert'
      : 'unknown';
    return { stage: stage as 'upload' | 'insert' | 'unknown', message: err.message };
  }
  const e = err as Error;
  return { stage: 'unknown', message: e.message ?? String(err) };
}
