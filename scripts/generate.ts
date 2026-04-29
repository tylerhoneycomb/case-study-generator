#!/usr/bin/env tsx
// =============================================================================
// scripts/generate.ts <slug> [--issue=N]
//
// Generate one case study end-to-end:
//   scrape → claude → humanize → image → MDX → commit.
//
// Rate-limit: consumes 1 token from .state/ratelimit.json. If the cap is hit,
// posts a queued comment + queued label on the tracking issue and exits 0.
// The detect cron drains queued issues before scanning for new ones.
//
// Used by:
//   - on-comment workflow (parsing /funded generate <slug>)
//   - detect workflow (per-campaign generation)
// =============================================================================

import { parseArgs, requirePositional } from './lib/args.js';
import { setTrackingIssue, info, error as logError, stage } from './lib/log.js';
import { runPipeline, PipelineError } from './lib/pipeline.js';
import { canConsume, consume, RateLimitExceeded } from './lib/ratelimit.js';
import { addLabel, addComment, closeIssue } from './lib/github.js';
import { findByCampaignSlug, deleteCaseStudy } from './lib/mdx.js';
import { removeHeroImage } from './lib/image.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const campaignSlug = requirePositional(args, 0, '<slug>');
  const issueRaw = args.values['issue'];
  const issueNumber = issueRaw ? Number.parseInt(issueRaw, 10) : null;
  const force = Boolean(args.flags['force']);

  if (issueNumber !== null && !Number.isNaN(issueNumber)) {
    setTrackingIssue(issueNumber);
  }

  info(`generate start`, { campaignSlug, issue: issueNumber, force });

  // Idempotency on the campaign, not on Claude's chosen slug. Two runs of
  // /funded generate <campaign> used to produce two MDX files because Claude
  // picks slightly different output slugs each call. findByCampaignSlug walks
  // every existing MDX and matches on its frontmatter.campaignSlug.
  const existing = await findByCampaignSlug(campaignSlug);
  if (existing && !force) {
    await stage(
      `⚠️ Case study already exists for campaign \`${campaignSlug}\` at \`/${existing.slug}\`. Pass \`--force\` to overwrite, or run \`/funded redraft ${existing.slug}\` to refresh with feedback.`,
    );
    process.exit(0);
  }
  if (existing && force) {
    await stage(`Overwriting existing case study at \`/${existing.slug}\` (force mode).`);
    // Delete the old MDX + hero image so the regenerated version is the
    // single source of truth — Claude may pick a different output slug, in
    // which case we'd otherwise leave an orphan file behind.
    await deleteCaseStudy(existing.slug);
    await removeHeroImage(existing.slug);
  }

  // Rate-limit precheck. If we can't consume, queue the issue and exit clean.
  if (!(await canConsume())) {
    await stage('⏸ Rate limit reached for today. Queued for tomorrow.');
    if (issueNumber !== null && !Number.isNaN(issueNumber)) {
      await addLabel(issueNumber, 'queued');
    }
    process.exit(0);
  }

  try {
    await consume();
  } catch (err) {
    if (err instanceof RateLimitExceeded) {
      await stage('⏸ Rate limit reached for today. Queued for tomorrow.');
      if (issueNumber !== null && !Number.isNaN(issueNumber)) {
        await addLabel(issueNumber, 'queued');
      }
      process.exit(0);
    }
    throw err;
  }

  try {
    const result = await runPipeline({ slug: campaignSlug });
    const slugUrl = `https://funded.honeycombcredit.com/${result.slug}`;
    await stage(`✅ Published — ${slugUrl}`, {
      commit: result.commitSha,
      cost: `$${result.estimatedCostUsd.toFixed(3)}`,
      humanizationPassed: result.humanizationPassed,
    });
    if (!result.humanizationPassed && issueNumber !== null && !Number.isNaN(issueNumber)) {
      await addLabel(issueNumber, 'needs-review');
      await addComment(
        issueNumber,
        `Humanization validator flagged the following:\n\n\`\`\`\n${result.humanizationIssuesText}\n\`\`\``,
      );
    }
    if (issueNumber !== null && !Number.isNaN(issueNumber)) {
      await addLabel(issueNumber, 'published');
      await closeIssue(issueNumber, 'completed');
    }
  } catch (err) {
    if (err instanceof PipelineError) {
      logError(`pipeline failed at ${err.stage}`, { message: err.message });
      await stage(`❌ Failed at ${err.stage}: ${err.message}`);
      if (issueNumber !== null && !Number.isNaN(issueNumber)) {
        await addLabel(issueNumber, 'error');
      }
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err: unknown) => {
  logError('generate crashed', { message: (err as Error).message });
  process.exit(1);
});
