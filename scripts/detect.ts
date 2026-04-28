#!/usr/bin/env tsx
// =============================================================================
// scripts/detect.ts — daily cron entry point.
//
// Logic per scope Section 6 / Section 4:
//   1. Load .state/observed-fundraising.json (every Fundraising slug we've
//      ever seen, plus lastKnownStage).
//   2. Scrape the listing on invest.honeycombcredit.com — gives us the
//      ~10 currently-active Fundraising campaigns.
//   3. Add new ones to state with lastKnownStage = "Fundraising".
//   4. For every observed slug whose lastKnownStage !== "Funded" AND that
//      no longer appears on the listing, fetch its detail page.
//      - If campaignStage is now "Funded", trigger generation (open issue +
//        run pipeline). State is updated to "Funded" only after generation
//        succeeds, so a transient failure leaves the slug pending for the
//        next run.
//      - If campaignStage is some other terminal state (e.g. "Closed"),
//        update state and move on.
//   5. Drain queued issues from earlier days (label `queued`) before
//      stopping. Implemented via the Issues API: fetch open issues with
//      label `queued`, parse the slug from the title, attempt generation.
//      Out of scope for this phase to fully implement queue draining; the
//      cron workflow re-fires the on-issue dispatcher per queued issue.
//
// On rate-limit exhaustion, remaining work is left as queued issues — same
// mechanism as backfill.
// =============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseArgs } from './lib/args.js';
import { info, error as logError, stage, setTrackingIssue } from './lib/log.js';
import { listListing, fetchCampaign, isFunded } from './lib/scrape.js';
import { runPipeline, PipelineError } from './lib/pipeline.js';
import { canConsume, consume, status as rateStatus, RateLimitExceeded } from './lib/ratelimit.js';
import { createIssue, addLabel, addComment, closeIssue } from './lib/github.js';
import { formatMoney } from './lib/format.js';
import * as git from './lib/git.js';

const STATE_FILE = path.resolve(process.cwd(), '.state/observed-fundraising.json');

interface Observed {
  // slug → lastKnownStage
  [slug: string]: { name: string; lastKnownStage: string; firstSeen: string };
}

async function readObserved(): Promise<Observed> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    return JSON.parse(raw) as Observed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

async function writeObserved(state: Observed): Promise<void> {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

interface DetectionSummary {
  scanned: number;
  newFundraisingTracked: number;
  candidatesChecked: number;
  newlyFunded: string[];
  generated: string[];
  queued: string[];
  failed: { slug: string; reason: string }[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(args.flags['dry-run']);

  info('detect start', { dryRun });

  const summary: DetectionSummary = {
    scanned: 0,
    newFundraisingTracked: 0,
    candidatesChecked: 0,
    newlyFunded: [],
    generated: [],
    queued: [],
    failed: [],
  };

  // ---- 1. Load state ----
  const observed = await readObserved();

  // ---- 2. Scrape listing ----
  let listing;
  try {
    listing = await listListing();
  } catch (err) {
    logError('listing scrape failed', { message: (err as Error).message });
    // Open a meta error issue so silent failures stay loud. If GitHub itself
    // is unreachable (or env vars are missing locally), don't let the
    // diagnostic call mask the original error.
    try {
      await createIssue({
        title: `🐝 Detection failed — ${new Date().toISOString().slice(0, 10)}`,
        body: `Listing scrape on invest.honeycombcredit.com failed:\n\n\`\`\`\n${(err as Error).message}\n\`\`\``,
        labels: ['error', 'detection'],
      });
    } catch (postErr) {
      logError('also failed to open tracking issue', { message: (postErr as Error).message });
    }
    process.exit(1);
  }
  summary.scanned = listing.length;

  // ---- 3. Add new Fundraising slugs to state ----
  const today = new Date().toISOString().slice(0, 10);
  const currentSlugs = new Set<string>();
  for (const item of listing) {
    currentSlugs.add(item.slug);
    if (!observed[item.slug]) {
      observed[item.slug] = {
        name: item.campaignName,
        lastKnownStage: 'Fundraising',
        firstSeen: today,
      };
      summary.newFundraisingTracked++;
    }
  }

  // ---- 4. For each tracked slug not currently listed, check stage ----
  const candidates = Object.entries(observed).filter(
    ([slug, meta]) => meta.lastKnownStage !== 'Funded' && !currentSlugs.has(slug),
  );

  for (const [slug, meta] of candidates) {
    summary.candidatesChecked++;
    let campaign;
    try {
      campaign = await fetchCampaign(slug);
    } catch (err) {
      // Defensive: a single 404/parse error doesn't fail the whole run.
      info('candidate fetch failed', { slug, error: (err as Error).message });
      continue;
    }

    if (!isFunded(campaign.campaignStage)) {
      // Not funded yet (or now in a different terminal stage); update state
      // so we don't recheck on every run.
      const ent = observed[slug];
      if (ent) ent.lastKnownStage = campaign.campaignStage;
      continue;
    }

    summary.newlyFunded.push(slug);

    if (dryRun) continue;

    // ---- Open tracking issue ----
    const totalRaised = campaign.totalFundsRaised ?? 0;
    const investors = campaign.numInvestors ?? 0;
    const issue = await createIssue({
      title: `🐝 ${campaign.campaignName} funded (${formatMoney(totalRaised)} / ${investors} investors)`,
      body: `Auto-detected via daily cron.\n\n- Campaign: ${campaign.campaignName}\n- Slug: \`${slug}\`\n- Funded: ${formatMoney(totalRaised)} from ${investors} investors\n- Source: https://invest.honeycombcredit.com/campaigns/${slug}`,
      labels: ['detection'],
    });
    setTrackingIssue(issue.number);

    // ---- Rate-limit check ----
    if (!(await canConsume())) {
      summary.queued.push(slug);
      await stage('⏸ Rate limit reached for today. Queued for tomorrow.');
      await addLabel(issue.number, 'queued');
      continue;
    }

    try {
      await consume();
    } catch (err) {
      if (err instanceof RateLimitExceeded) {
        summary.queued.push(slug);
        await stage('⏸ Rate limit reached for today. Queued for tomorrow.');
        await addLabel(issue.number, 'queued');
        continue;
      }
      throw err;
    }

    // ---- Run pipeline ----
    try {
      const result = await runPipeline({ slug });
      const url = `https://funded.honeycombcredit.com/${result.slug}`;
      await stage(`✅ Published — ${url}`, { commit: result.commitSha });
      const ent = observed[slug];
      if (ent) ent.lastKnownStage = 'Funded';
      summary.generated.push(result.slug);
      await addLabel(issue.number, 'published');
      if (!result.humanizationPassed) {
        await addLabel(issue.number, 'needs-review');
        await addComment(
          issue.number,
          `Humanization validator flagged the following:\n\n\`\`\`\n${result.humanizationIssuesText}\n\`\`\``,
        );
      }
      await closeIssue(issue.number, 'completed');
    } catch (err) {
      const reason = err instanceof PipelineError ? `${err.stage}: ${err.message}` : (err as Error).message;
      summary.failed.push({ slug, reason });
      await stage(`❌ Generation failed — ${reason}`);
      await addLabel(issue.number, 'error');
    }
    setTrackingIssue(null);
  }

  // ---- Persist state and commit ----
  await writeObserved(observed);

  if (!dryRun) {
    await git.configureBotIdentity();
    await git.add(STATE_FILE);
    await git.commit('chore(state): update observed-fundraising state');
  }

  // ---- Daily summary ----
  const summaryBody = [
    `**Daily detection — ${today}**`,
    '',
    `- Listing campaigns scanned: ${summary.scanned}`,
    `- New Fundraising slugs tracked: ${summary.newFundraisingTracked}`,
    `- Candidates re-checked: ${summary.candidatesChecked}`,
    `- Newly funded: ${summary.newlyFunded.length}${summary.newlyFunded.length ? ` (${summary.newlyFunded.map((s) => `\`${s}\``).join(', ')})` : ''}`,
    `- Generated: ${summary.generated.length}`,
    `- Queued (rate limit): ${summary.queued.length}`,
    `- Failed: ${summary.failed.length}`,
    '',
    `Rate state: ${JSON.stringify(await rateStatus())}`,
  ].join('\n');

  info('detect summary', { ...summary });
  if (!dryRun && (summary.newlyFunded.length > 0 || summary.failed.length > 0)) {
    try {
      await createIssue({
        title: `[meta] Daily detection log — ${today}`,
        body: summaryBody,
        labels: ['detection', 'meta'],
      });
    } catch (postErr) {
      logError('failed to open daily summary issue', { message: (postErr as Error).message });
    }
  }
}

main().catch((err: unknown) => {
  logError('detect crashed', { message: (err as Error).message });
  process.exit(1);
});
