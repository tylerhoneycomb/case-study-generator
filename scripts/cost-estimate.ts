#!/usr/bin/env tsx
// =============================================================================
// scripts/cost-estimate.ts <slug> [<slug>...] [--issue=N]
//
// Estimate the $ cost to generate the given list of slugs without spending.
// Invoked by /funded cost-estimate <slug…>.
// =============================================================================

import { parseArgs } from './lib/args.js';
import { setTrackingIssue, error as logError, stage } from './lib/log.js';
import { estimateCostForGeneration } from './lib/claude.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const issueRaw = args.values['issue'];
  const issueNumber = issueRaw ? Number.parseInt(issueRaw, 10) : null;
  const slugs = args.positional.filter((s) => s.length > 0);

  if (issueNumber !== null && !Number.isNaN(issueNumber)) {
    setTrackingIssue(issueNumber);
  }

  if (slugs.length === 0) {
    await stage('❌ Pass one or more slugs.');
    process.exit(2);
  }

  const perSlug = estimateCostForGeneration();
  const total = perSlug * slugs.length;
  const body = [
    `**Cost estimate**`,
    '',
    `${slugs.length} slug${slugs.length === 1 ? '' : 's'} × ~$${perSlug.toFixed(3)} ≈ **$${total.toFixed(2)}**`,
    '',
    `Slugs: ${slugs.map((s) => `\`${s}\``).join(', ')}`,
    '',
    `Estimate is based on a typical input of ~17,000 tokens (prompt ~14k + campaign payload ~3k) and a typical output of ~2,800 tokens at the active model's published rate. Actual cost varies with the campaign's summary length.`,
  ].join('\n');

  await stage(body);
}

main().catch((err: unknown) => {
  logError('cost-estimate crashed', { message: (err as Error).message });
  process.exit(1);
});
