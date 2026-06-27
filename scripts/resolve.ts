#!/usr/bin/env tsx
// =============================================================================
// scripts/resolve.ts <name>... [--names="A\nB"] [--json]
//
// Turn operator-supplied business *names* into Honeycomb campaign *slugs*
// and funding stages, using one free PostHog query. This is the cheap
// "find the business" step that runs BEFORE any generation:
//
//   - No Anthropic spend (it never calls Claude).
//   - No GitHub Actions run required (it's a local CLI against PostHog).
//   - It's the exit condition: a name that doesn't exist, isn't funded, or
//     is ambiguous is reported and NOT advanced to generation — so we never
//     waste a pipeline run (or an Actions minute) chasing content that
//     isn't there.
//
// Typical flow:
//   npx tsx scripts/resolve.ts "The Ladies Room" "Sigma Snacks"
//   # → copy the printed fundable slugs into a Backfill issue / `backfill.ts`
//
// Requires POSTHOG_API_KEY + POSTHOG_PROJECT_ID in env (same secrets the
// detect cron uses). Optional POSTHOG_HOST for EU cloud.
//
// Exit codes:
//   0 — every supplied name resolved to exactly one fundable campaign
//   1 — at least one name was not found / not fundable / ambiguous
//   2 — no names supplied
// =============================================================================

import { parseArgs } from './lib/args.js';
import { resolveCampaignsByName, type NameResolution } from './lib/posthog.js';

function collectNames(positional: string[], namesValue: string | undefined): string[] {
  const fromFlag = (namesValue ?? '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...positional, ...fromFlag];
}

function printHuman(results: NameResolution[]): void {
  for (const r of results) {
    if (!r.found) {
      console.log(`❌ ${r.query} — NOT FOUND (no campaign matches this name)`);
      continue;
    }
    if (r.ambiguous) {
      console.log(`⚠️  ${r.query} — AMBIGUOUS (${r.candidates.length} matches):`);
      for (const c of r.candidates) {
        console.log(`      ${c.slug}  [${c.campaignStage}]  ${c.campaignName}`);
      }
      continue;
    }
    const m = r.match!;
    if (r.fundable) {
      console.log(`✅ ${r.query} — ${m.slug}  [${m.campaignStage}]  (closed ${m.fundedAt || 'n/a'})`);
    } else {
      console.log(`⛔ ${r.query} — ${m.slug}  [${m.campaignStage}]  NOT FUNDABLE (skip)`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const names = collectNames(args.positional, args.values['names']);
  const asJson = Boolean(args.flags['json']);

  if (names.length === 0) {
    console.error('Usage: resolve.ts <name>... [--names="A\\nB"] [--json]');
    process.exit(2);
  }

  const results = await resolveCampaignsByName(names);

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    printHuman(results);
    const fundable = results.filter((r) => r.fundable).map((r) => r.match!.slug);
    if (fundable.length) {
      console.log('\nFundable slugs (ready to backfill):');
      console.log(fundable.join('\n'));
    }
  }

  // Gate semantics: non-zero unless every name resolved to one fundable match.
  const allClean = results.length > 0 && results.every((r) => r.fundable);
  process.exit(allClean ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(`resolve crashed: ${(err as Error).message}`);
  process.exit(1);
});
