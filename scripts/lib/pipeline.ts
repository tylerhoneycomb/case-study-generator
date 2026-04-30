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
  // Honeycomb campaign slug — what fetchCampaign() looks up.
  slug: string;
  // Optional: caller-supplied feedback (used by redraft)
  feedback?: string;
  // Optional: skip the funded-status check. Backfill uses this because
  // historical campaigns may have stages other than "Funded" but should
  // still be published.
  skipFundedCheck?: boolean;
  // Optional: override the case-study slug Claude returns. Used by redraft
  // so the regenerated MDX overwrites the existing file (preserving the
  // public URL) instead of producing a sibling at a slightly different
  // slug. Generate doesn't pass this — it uses Claude's chosen slug.
  forcedOutputSlug?: string;
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
  let pageProps: unknown;
  let pageHtml: string;
  try {
    const fetched = await fetchCampaign(slug);
    campaign = fetched.campaign;
    pageProps = fetched.pageProps;
    pageHtml = fetched.html;
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
  // extractHeroImageUrl priority chain (most stable → least stable):
  //   1. pageProps.ogImageUrl  ← canonical Honeycomb OG field (primary fix)
  //   2. campaign.ogImageUrl   ← v3.3 spec inner field
  //   3. top-level alternates  ← heroImageUrl, coverImageUrl, etc.
  //   4. campaignMedia[]       ← common newer-campaign location
  //   5. deep-scan(pageProps)  ← catch-all for unknown sibling shapes
  //   6. HTML <img> regex      ← defense-in-depth, last resort
  const heroUrl = extractHeroImageUrl(campaign, pageProps, pageHtml);
  if (!heroUrl) {
    throw new PipelineError(
      'image',
      `Campaign "${slug}" has no findable hero image (checked pageProps.ogImageUrl, campaign.ogImageUrl, top-level alternates, campaignMedia, pageProps deep scan, HTML scrape).`,
    );
  }
  // The output case-study slug. Caller (e.g. redraft) can pin it to keep
  // the existing URL stable; otherwise we use whatever Claude generated.
  const outputSlug = opts.forcedOutputSlug ?? claude.output.slug;

  await stage('🖼️ Fetching hero image', { source: heroUrl });
  const img = await fetchAndStoreHeroImage({
    ogImageUrl: heroUrl,
    slug: outputSlug,
  });

  // ---- 5. Compose frontmatter + write MDX ----
  // Round all numeric fields to integers — the content-collection schema
  // (src/content/config.ts) requires .int() and Honeycomb's payload can
  // carry floating-point values for monetary fields (e.g., 46841.5
  // serialized as 46841.50001525879 due to JSON float imprecision). Without
  // rounding, the build fails Astro content validation and the deploy
  // never lands.
  const amountRaisedInt = Math.round(totalFundsRaised);
  const goalAmountInt = Math.round(target);
  const investorsInt = Math.round(investors);
  const percent = goalAmountInt > 0 ? (amountRaisedInt / goalAmountInt) * 100 : 0;
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
    amountRaised: amountRaisedInt,
    amountRaisedFormatted: formatMoney(amountRaisedInt),
    goalAmount: goalAmountInt,
    goalAmountFormatted: formatMoney(goalAmountInt),
    percentOfGoal: Math.round(percent),
    percentOfGoalFormatted: formatPercent(percent),
    investorCount: investorsInt,
    timeToFund: formatTimeToFund(start, end),
    metaTitle: claude.output.metaTitle,
    metaDescription: claude.output.metaDescription,
    ogTitle: claude.output.ogTitle,
    ogDescription: claude.output.ogDescription,
    ctaText: claude.output.ctaText,
    // ctaUrl is no longer in frontmatter — Cta.astro constructs the
    // UTM-tagged pre-qualify href from a constant base + campaignSlug.
    campaignUrl: buildCampaignUrl(campaign.slug),
    campaignId: campaign.campaignId,
    campaignSlug: campaign.slug,
    publishedDate: todayISO(),
    systemSchemaJson: claude.systemSchemaJsonParsed,
  };

  const written = await writeCaseStudy({
    slug: outputSlug,
    frontmatter,
    body: claude.output.story,
  });

  // ---- 6. Commit ----
  await git.configureBotIdentity();
  await git.add(written.path, `public${img.publicPath}`);
  const commitResult = await git.commit(
    `feat(case-study): publish ${campaign.campaignName} (${outputSlug})`,
  );
  if (commitResult.committed) {
    info('committed', { slug: outputSlug });
  } else {
    warn('no changes to commit', { slug: outputSlug });
  }
  const sha = await git.commitSha();

  return {
    slug: outputSlug,
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
