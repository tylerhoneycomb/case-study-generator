#!/usr/bin/env tsx
// =============================================================================
// scripts/backfill.ts --slugs="..." [--force] [--dry-run] [--rate=N] [--issue=N]
//
// Process a list of historical funded campaign slugs (one per line, supplied
// via the Backfill issue form's "Slugs" textarea). Each slug:
//   - skipped if MDX exists, unless --force
//   - skipped under --dry-run after estimating cost
//   - subject to rate-limit (default 1/day, --rate up to 10/day)
//
// On rate-limit hit, remaining slugs are surfaced in the tracking issue with
// a `queued` label so the next day's run can pick them up.
// =============================================================================

import { parseArgs } from './lib/args.js';
import { setTrackingIssue, info, error as logError, stage } from './lib/log.js';
import { runPipeline, PipelineError } from './lib/pipeline.js';
import {
  consume,
  status as rateStatus,
  RateLimitExceeded,
  constants as rateConstants,
} from './lib/ratelimit.js';
import { exists } from './lib/mdx.js';
import { estimateCostForGeneration } from './lib/claude.js';
import { addLabel, addComment } from './lib/github.js';
import { parseSlugs } from './lib/parse-slugs.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const slugs = parseSlugs(args.values['slugs']);
  const force = Boolean(args.flags['force']);
  const dryRun = Boolean(args.flags['dry-run']);
  const rateOverrideRaw = args.values['rate'];
  const rate = rateOverrideRaw ? Number.parseInt(rateOverrideRaw, 10) : undefined;
  const issueRaw = args.values['issue'];
  const issueNumber = issueRaw ? Number.parseInt(issueRaw, 10) : null;

  if (issueNumber !== null && !Number.isNaN(issueNumber)) {
    setTrackingIssue(issueNumber);
  }

  if (slugs.length === 0) {
    await stage('❌ No slugs supplied. Pass --slugs="slug-a\\nslug-b".');
    process.exit(2);
  }

  const cap =
    rate && rate > 0 && rate <= rateConstants.HARD_MAX_OVERRIDE
      ? rate
      : rateConstants.DEFAULT_CAP;

  info('backfill start', { count: slugs.length, force, dryRun, cap });
  await stage(`🔁 Backfill of ${slugs.length} slug(s) starting (cap=${cap}, force=${force}, dryRun=${dryRun})`);

  // Dry-run: estimate cost without scraping or generating.
  if (dryRun) {
    const perSlug = estimateCostForGeneration();
    const total = perSlug * slugs.length;
    await stage(
      `💰 Cost estimate: ${slugs.length} × $${perSlug.toFixed(3)} ≈ $${total.toFixed(2)}`,
      { perSlug, total, slugs },
    );
    process.exit(0);
  }

  const succeeded: string[] = [];
  const skipped: string[] = [];
  const queued: string[] = [];
  const failed: { slug: string; reason: string }[] = [];

  for (const slug of slugs) {
    if (!force && (await exists(slug))) {
      skipped.push(slug);
      await stage(`↪️ Skipping \`${slug}\` (already published, no --force)`);
      continue;
    }

    const before = await rateStatus(cap);
    if (before.remaining <= 0) {
      queued.push(slug);
      continue;
    }

    try {
      await consume({ capOverride: cap });
    } catch (err) {
      if (err instanceof RateLimitExceeded) {
        queued.push(slug);
        continue;
      }
      throw err;
    }

    try {
      const result = await runPipeline({ slug, skipFundedCheck: true });
      succeeded.push(result.slug);
      await stage(
        `✅ \`${slug}\` → /${result.slug} (cost $${result.estimatedCostUsd.toFixed(3)})`,
      );
    } catch (err) {
      const reason = err instanceof PipelineError ? `${err.stage}: ${err.message}` : (err as Error).message;
      failed.push({ slug, reason });
      await stage(`❌ \`${slug}\` failed — ${reason}`);
    }
  }

  await stage('🏁 Backfill complete', {
    succeeded: succeeded.length,
    skipped: skipped.length,
    queued: queued.length,
    failed: failed.length,
  });

  if (queued.length > 0 && issueNumber !== null && !Number.isNaN(issueNumber)) {
    await addLabel(issueNumber, 'queued');
    await addComment(
      issueNumber,
      `Queued for tomorrow (rate limit reached): ${queued.map((s) => `\`${s}\``).join(', ')}`,
    );
  }
  if (failed.length > 0 && issueNumber !== null && !Number.isNaN(issueNumber)) {
    await addLabel(issueNumber, 'error');
  }
}

main().catch((err: unknown) => {
  logError('backfill crashed', { message: (err as Error).message });
  process.exit(1);
});
