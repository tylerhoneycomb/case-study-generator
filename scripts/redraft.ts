#!/usr/bin/env tsx
// =============================================================================
// scripts/redraft.ts <slug> [--feedback="..."] [--issue=N]
//
// Regenerate one case study with optional reviewer feedback. Overwrites the
// existing MDX in place. Consumes 1 rate-limit token.
// =============================================================================

import { parseArgs, requirePositional } from './lib/args.js';
import { setTrackingIssue, info, error as logError, stage } from './lib/log.js';
import { runPipeline, PipelineError } from './lib/pipeline.js';
import { consume, canConsume, RateLimitExceeded } from './lib/ratelimit.js';
import { addLabel, addComment } from './lib/github.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const slug = requirePositional(args, 0, '<slug>');
  const feedback = args.values['feedback'];
  const issueRaw = args.values['issue'];
  const issueNumber = issueRaw ? Number.parseInt(issueRaw, 10) : null;

  if (issueNumber !== null && !Number.isNaN(issueNumber)) {
    setTrackingIssue(issueNumber);
  }

  info(`redraft start`, { slug, hasFeedback: Boolean(feedback) });

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
    // Redraft is just runPipeline with feedback + skipFundedCheck (the
    // campaign is already a published case study, so the funded gate is
    // moot and might fail if the platform later changed the stage).
    const opts = feedback !== undefined
      ? { slug, feedback, skipFundedCheck: true }
      : { slug, skipFundedCheck: true };
    const result = await runPipeline(opts);
    const slugUrl = `https://funded.honeycombcredit.com/${result.slug}`;
    await stage(`✅ Redrafted — ${slugUrl}`, {
      commit: result.commitSha,
      cost: `$${result.estimatedCostUsd.toFixed(3)}`,
      humanizationPassed: result.humanizationPassed,
    });
    if (!result.humanizationPassed && issueNumber !== null && !Number.isNaN(issueNumber)) {
      await addComment(
        issueNumber,
        `Humanization validator flagged the redraft:\n\n\`\`\`\n${result.humanizationIssuesText}\n\`\`\``,
      );
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
