#!/usr/bin/env tsx
// =============================================================================
// scripts/redraft.ts <case-study-slug> [--feedback="..."] [--issue=N]
//
// Regenerate one case study with optional reviewer feedback. The input is
// the *case-study slug* (the URL path / MDX filename), NOT the Honeycomb
// campaign slug — the redraft form and slash command both pass that.
//
// Pipeline:
//   1. Read existing MDX → recover the campaignSlug from frontmatter
//   2. Re-run the full pipeline against that campaignSlug
//   3. Pin the output slug to the input case-study slug so the URL stays
//      stable across redrafts (without this, Claude would pick a new slug
//      each time and we'd accumulate orphaned files)
//
// Consumes 1 rate-limit token.
// =============================================================================

import { parseArgs, requirePositional } from './lib/args.js';
import { setTrackingIssue, info, error as logError, stage } from './lib/log.js';
import { runPipeline, PipelineError } from './lib/pipeline.js';
import { consume, canConsume, RateLimitExceeded } from './lib/ratelimit.js';
import { addLabel } from './lib/github.js';
import { readCaseStudy } from './lib/mdx.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const caseStudySlug = requirePositional(args, 0, '<case-study-slug>');
  const feedback = args.values['feedback'];
  const issueRaw = args.values['issue'];
  const issueNumber = issueRaw ? Number.parseInt(issueRaw, 10) : null;

  if (issueNumber !== null && !Number.isNaN(issueNumber)) {
    setTrackingIssue(issueNumber);
  }

  info(`redraft start`, { caseStudySlug, hasFeedback: Boolean(feedback) });

  // Look up the existing MDX so we can read its campaignSlug and run the
  // pipeline against the right Honeycomb campaign.
  const existing = await readCaseStudy(caseStudySlug);
  if (!existing) {
    await stage(
      `❌ No case study found at \`/${caseStudySlug}\`. Use the case-study slug (the URL path), not the Honeycomb campaign slug.`,
    );
    process.exit(2);
  }
  const campaignSlug = existing.frontmatter['campaignSlug'];
  if (typeof campaignSlug !== 'string' || campaignSlug.length === 0) {
    await stage(
      `❌ Case study at \`/${caseStudySlug}\` has no campaignSlug in its frontmatter. Hand-edit the MDX to add it, then retry.`,
    );
    process.exit(2);
  }

  if (!(await canConsume())) {
    await stage('⏸ Rate limit reached. Redraft queued for tomorrow.');
    if (issueNumber !== null && !Number.isNaN(issueNumber)) {
      await addLabel(issueNumber, 'queued');
    }
    process.exit(0);
  }

  try {
    await consume();
  } catch (err) {
    if (err instanceof RateLimitExceeded) {
      await stage('⏸ Rate limit reached. Redraft queued for tomorrow.');
      process.exit(0);
    }
    throw err;
  }

  try {
    // Run the pipeline against the recovered Honeycomb campaign slug, but
    // pin the output slug so the regenerated MDX overwrites the existing
    // file rather than producing a sibling at a slightly different slug.
    // skipFundedCheck: a published case study might be a campaign whose
    // platform stage has since drifted; the funded gate is moot here.
    const opts = {
      slug: campaignSlug,
      forcedOutputSlug: caseStudySlug,
      skipFundedCheck: true,
      ...(feedback !== undefined ? { feedback } : {}),
    };
    const result = await runPipeline(opts);
    const slugUrl = `https://funded.honeycombcredit.com/${result.slug}`;
    await stage(`✅ Redrafted — ${slugUrl}`, {
      commit: result.commitSha,
      cost: `$${result.estimatedCostUsd.toFixed(3)}`,
      attempts: result.attempts,
    });
    if (
      result.humanizationWarnings &&
      issueNumber !== null &&
      !Number.isNaN(issueNumber)
    ) {
      await addLabel(issueNumber, 'humanization-warning');
    }
  } catch (err) {
    if (err instanceof PipelineError) {
      logError(`redraft failed at ${err.stage}`, { message: err.message });
      await stage(`❌ Redraft failed at ${err.stage}: ${err.message}`);
      if (issueNumber !== null && !Number.isNaN(issueNumber)) {
        await addLabel(issueNumber, 'error');
      }
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err: unknown) => {
  logError('redraft crashed', { message: (err as Error).message });
  process.exit(1);
});
