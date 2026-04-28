// =============================================================================
// Shared per-slug generation pipeline. Used by generate.ts, redraft.ts, and
// backfill.ts — all of which differ only in their argument source and the
// pre-conditions they enforce (rate-limit, idempotency, feedback string).
//
// Stages, each posted to the tracking issue (when one is set):
//   1. Fetch detail from invest.honeycombcredit.com
//   2. Call Claude
//   3. Run humanization validator
//   4. Fetch + store hero image
//   5. Write MDX
//   6. git add + commit
// =============================================================================

import { fetchCampaign, campaignUrl as buildCampaignUrl, isCampaignSuccessful, extractHeroImageUrl } from './scrape.js';
import { generateCaseStudy, type InputPayload } from './claude.js';
import { validateCopy, stripHtml, formatIssuesForReviewer } from './humanize.js';
import { fetchAndStoreHeroImage } from './image.js';
import { writeCaseStudy } from './mdx.js';
import * as git from './git.js';
import { stage, info, warn } from './log.js';
import { formatMoney, formatPercent, formatTimeToFund, todayISO } from './format.js';
import type { Campaign } from './schemas.js';

export interface RunOptions {
  slug: string;
  // Optional: caller-supplied feedback (used by redraft)
  feedback?: string;
  // Optional: skip the funded-status check. Backfill uses this because
  // historical campaigns may have stages other than "Funded" but should
  // still be published.
  skipFundedCheck?: boolean;
}

export interface RunResult {
  slug: string;
  publishedPath: string;
  imagePath: string;
  estimatedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  humanizationPassed: boolean;
  humanizationIssuesText: string;
  commitSha: string;
}

export class PipelineError extends Error {
  constructor(public readonly stage: string, message: string) {
    super(message);
    this.name = 'PipelineError';
  }
}

export async function runPipeline(opts: RunOptions): Promise<RunResult> {
  const { slug } = opts;

  // ---- 1. Fetch detail ----
  await stage(`📥 Fetching campaign detail for \`${slug}\``);
  let campaign: Campaign;
  let initialCampaignData: unknown;
  try {
    const fetched = await fetchCampaign(slug);
    campaign = fetched.campaign;
    initialCampaignData = fetched.initialCampaignData;
  } catch (err) {
    throw new PipelineError('scrape', (err as Error).message);
  }

  if (!opts.skipFundedCheck && !isCampaignSuccessful(campaign.campaignStage)) {
    throw new PipelineError(
      'precheck',
      `Campaign "${slug}" is in stage "${campaign.campaignStage}". Generation requires a successful stage (Funded or Successful - Finalizing). Backfill skips this check.`,
    );
  }

  const issuer = campaign.issuer ?? {};
  const city = issuer.city ?? '';
  const stateAbbr = (issuer.state ?? '').toUpperCase();
  const totalFundsRaised = campaign.totalFundsRaised ?? 0;
  const target = campaign.campaignTargetAmount ?? 0;
  const investors = campaign.numInvestors ?? 0;
  const start = campaign.campaignStartDate ?? '';
  const end = campaign.campaignExpirationDate ?? '';

  if (!city || !stateAbbr || !target || !campaign.summary) {
    throw new PipelineError(
      'precheck',
      `Campaign "${slug}" is missing required fields (city/state/target/summary). Cannot generate.`,
    );
  }

  // ---- 2. Call Claude ----
  await stage('🧠 Generating content (Claude API)');
  const payload: InputPayload = {
    campaignName: campaign.campaignName,
    campaignSlug: campaign.slug,
    campaignId: campaign.campaignId,
    todayISO: todayISO(),
    city,
    state: stateAbbr,
    totalFundsRaised,
    campaignTargetAmount: target,
    numInvestors: investors,
    campaignStartDate: start,
    campaignExpirationDate: end,
    summary: campaign.summary,
    ...(campaign.useOfProceeds !== undefined ? { useOfProceeds: campaign.useOfProceeds } : {}),
    ...(issuer.website !== undefined ? { issuerWebsite: issuer.website } : {}),
    ...(issuer.description !== undefined ? { issuerDescription: issuer.description } : {}),
    ...(campaign.ogImageUrl !== undefined ? { ogImageUrl: campaign.ogImageUrl } : {}),
    // (Note: extractHeroImageUrl is the source of truth for the hero image
    // path used to fetch and store the asset; the input payload above is
    // just the model's signal, not the fetch source.)
    ...(opts.feedback !== undefined ? { redraftFeedback: opts.feedback } : {}),
  };

  let claude;
  try {
    claude = await generateCaseStudy(payload);
  } catch (err) {
    throw new PipelineError('claude', (err as Error).message);
  }

  await stage(`✅ Claude returned. Cost: $${claude.usage.estimatedCostUsd.toFixed(3)}`, {
    inputTokens: claude.usage.inputTokens,
    outputTokens: claude.usage.outputTokens,
  });

  // ---- 3. Humanization ----
  const plain = stripHtml(claude.output.story);
  const human = validateCopy(plain);
  const humanizationIssuesText = formatIssuesForReviewer(human.issues);
  if (!human.passed) {
    warn('Humanization validator flagged issues', {
      issues: human.issues.map((i) => i.type),
    });
    await stage('⚠️ Humanization validator flagged issues — review needed', {
      issueCount: human.issues.length,
      flags: human.issues.map((i) => i.type),
    });
  } else {
    await stage('✅ Humanization passed');
  }

  // ---- 4. Fetch + store hero image ----
  // extractHeroImageUrl walks ogImageUrl → top-level alternates → campaignMedia
  // → bounded deep scan of campaignData.data → bounded deep scan of the wider
  // initialCampaignData blob. The last step is what catches campaigns where
  // the image lives in a sibling (e.g. initialCampaignData.media).
  const heroUrl = extractHeroImageUrl(campaign, initialCampaignData);
  if (!heroUrl) {
    throw new PipelineError(
      'image',
      `Campaign "${slug}" has no findable hero image (checked ogImageUrl, top-level alternates, campaignMedia, campaignData deep scan, initialCampaignData deep scan).`,
    );
  }
  await stage('🖼️ Fetching hero image', { source: heroUrl });
  const img = await fetchAndStoreHeroImage({
    ogImageUrl: heroUrl,
    slug: claude.output.slug,
  });

  // ---- 5. Compose frontmatter + write MDX ----
  const percent = target > 0 ? (totalFundsRaised / target) * 100 : 0;
  const frontmatter = {
    businessName: campaign.campaignName,
    niche: claude.output.niche,
    industry: claude.output.industry,
    city,
    state: stateAbbr,
    h1Heading: claude.output.h1Heading,
    heroSubhead: claude.output.heroSubhead,
    storyHeading: claude.output.storyHeading,
    heroImage: img.publicPath,
    heroImageAlt: claude.output.heroImageAlt,
    ogImage: img.publicPath,
    amountRaised: totalFundsRaised,
    amountRaisedFormatted: formatMoney(totalFundsRaised),
    goalAmount: target,
    goalAmountFormatted: formatMoney(target),
    percentOfGoal: Math.round(percent),
    percentOfGoalFormatted: formatPercent(percent),
    investorCount: investors,
    timeToFund: formatTimeToFund(start, end),
    metaTitle: claude.output.metaTitle,
    metaDescription: claude.output.metaDescription,
    ogTitle: claude.output.ogTitle,
    ogDescription: claude.output.ogDescription,
    ctaText: claude.output.ctaText,
    ctaUrl: 'https://honeycombcredit.com/pre-qualify',
    campaignUrl: buildCampaignUrl(campaign.slug),
    campaignId: campaign.campaignId,
    campaignSlug: campaign.slug,
    publishedDate: todayISO(),
    systemSchemaJson: claude.systemSchemaJsonParsed,
  };

  const written = await writeCaseStudy({
    slug: claude.output.slug,
    frontmatter,
    body: claude.output.story,
  });

  // ---- 6. Commit ----
  await git.configureBotIdentity();
  await git.add(written.path, `public${img.publicPath}`);
  const commitResult = await git.commit(
    `feat(case-study): publish ${campaign.campaignName} (${claude.output.slug})`,
  );
  if (commitResult.committed) {
    info('committed', { slug: claude.output.slug });
  } else {
    warn('no changes to commit', { slug: claude.output.slug });
  }
  const sha = await git.commitSha();

  return {
    slug: claude.output.slug,
    publishedPath: written.path,
    imagePath: img.publicPath,
    estimatedCostUsd: claude.usage.estimatedCostUsd,
    inputTokens: claude.usage.inputTokens,
    outputTokens: claude.usage.outputTokens,
    humanizationPassed: human.passed,
    humanizationIssuesText,
    commitSha: sha,
  };
}
