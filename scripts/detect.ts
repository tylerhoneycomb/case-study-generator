#!/usr/bin/env tsx
// =============================================================================
// scripts/detect.ts — daily cron entry point.
//
// Discovery now comes from PostHog (Fivetran-mirrored postgres.campaigns),
// not the invest.honeycombcredit.com listing scrape. The listing was a known
// blind spot: it surfaces only the ~10 most-active Fundraising campaigns,
// so any campaign that funded while off the visible window was invisible
// to the cron forever. PostHog returns every funded campaign in one query.
//
// Per Tyler:
//   - Pre-Jan-2026 campaigns are filtered out at the query level. He'll
//     hand-pick historical case studies via the Backfill Issue Form.
//   - Jan-2026+ campaigns are processed newest-first, rate-limited at 3/day.
//     A fresh transition is, by definition, the newest row, so it naturally
//     cuts in line.
//   - Tracking issues open AFTER the rate-limit gate. Candidates beyond the
//     daily cap are silently deferred to tomorrow's run; their existence is
//     surfaced only in the appended detection-log row. (We don't want a
//     wave of "queued" issues every time the cron sees more than 3 funded
//     campaigns at once.)
//
// On any pipeline failure, the per-campaign tracking issue stays open with
// the `error` label. The fix is to address the failure and re-run via the
// admin portal or `/funded generate <slug>`.
// =============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseArgs } from './lib/args.js';
import { info, error as logError, stage, setTrackingIssue } from './lib/log.js';
import { fetchFundedCampaigns, PostHogError } from './lib/posthog.js';
import { listAllCampaignSlugs } from './lib/mdx.js';
import { runPipeline, PipelineError } from './lib/pipeline.js';
import { canConsume, consume, status as rateStatus, RateLimitExceeded } from './lib/ratelimit.js';
import { createIssue, addLabel, addComment, closeIssue } from './lib/github.js';
import * as git from './lib/git.js';

const LOG_FILE = path.resolve(process.cwd(), '.state/detection-log.md');

// Append a row to .state/detection-log.md on every run, including
// zero-activity days. The cron is otherwise silent on quiet days; a state
// file (not an Issue) gives the operator a way to confirm the cron ran
// without generating notification noise on watchers' inboxes.
async function appendDetectionLog(row: {
  ranAt: string;
  posthogReturned: number;
  alreadyPublished: number;
  eligible: number;
  generated: number;
  rateLimitDeferred: number;
  failed: number;
}): Promise<void> {
  await fs.mkdir(path.dirname(LOG_FILE), { recursive: true });

  const header =
    '# Detection log\n\n' +
    'One row per cron run. Zero-activity rows confirm the cron ran without ' +
    'finding new transitions. Errors and per-campaign generations still open ' +
    'GitHub issues; this file is the audit trail for the rest.\n\n' +
    '| ran at | posthog returned | already published | eligible | generated | rate-limit deferred | failed |\n' +
    '|---|---|---|---|---|---|---|\n';

  const rowLine = `| ${row.ranAt} | ${row.posthogReturned} | ${row.alreadyPublished} | ${row.eligible} | ${row.generated} | ${row.rateLimitDeferred} | ${row.failed} |\n`;

  let existing = '';
  try {
    existing = await fs.readFile(LOG_FILE, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  if (!existing) {
    await fs.writeFile(LOG_FILE, header + rowLine, 'utf8');
    return;
  }
  // Already on the new schema — just append.
  if (existing.includes('| posthog returned |')) {
    await fs.appendFile(LOG_FILE, rowLine, 'utf8');
    return;
  }
  // Migrate from the legacy 8-column listing-scrape header. Keep historical
  // rows above a delimiter so the audit trail stays intact, then write the
  // new header + this run's row beneath it.
  const migrated =
    existing.trimEnd() +
    '\n\n' +
    '<!-- schema migrated to PostHog detection on ' +
    new Date().toISOString().slice(0, 10) +
    ' -->\n\n' +
    header +
    rowLine;
  await fs.writeFile(LOG_FILE, migrated, 'utf8');
}

interface DetectionSummary {
  posthogReturned: number;
  alreadyPublished: number;
  eligible: string[];
  generated: string[];
  rateLimitDeferred: string[];
  failed: { slug: string; reason: string }[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(args.flags['dry-run']);

  info('detect start', { dryRun });

  const summary: DetectionSummary = {
    posthogReturned: 0,
    alreadyPublished: 0,
    eligible: [],
    generated: [],
    rateLimitDeferred: [],
    failed: [],
  };

  // ---- 1. Query PostHog for funded campaigns (>= 2026-01-01, newest first) ----
  let candidates;
  try {
    candidates = await fetchFundedCampaigns();
  } catch (err) {
    logError('posthog query failed', { message: (err as Error).message });
    const errName = err instanceof PostHogError ? err.name : (err as Error).name;
    try {
      await createIssue({
        title: `🐝 Detection failed — ${new Date().toISOString().slice(0, 10)}`,
        body: `PostHog discovery query failed:\n\n\`\`\`\n${errName}: ${(err as Error).message}\n\`\`\``,
        labels: ['error', 'detection'],
      });
    } catch (postErr) {
      logError('also failed to open tracking issue', { message: (postErr as Error).message });
    }
    process.exit(1);
  }
  summary.posthogReturned = candidates.length;

  // ---- 2. Filter against already-published case studies ----
  const published = await listAllCampaignSlugs();
  const eligible = candidates.filter((c) => !published.has(c.slug));
  summary.alreadyPublished = candidates.length - eligible.length;
  summary.eligible = eligible.map((c) => c.slug);

  // ---- 3. Iterate eligible candidates newest-first, rate-limited ----
  for (const candidate of eligible) {
    if (dryRun) {
      // Account for what *would* have been deferred under the live cap so
      // the dry-run row is honest about queue depth. canConsume() doesn't
      // mutate state, so this is safe to call repeatedly.
      if (!(await canConsume())) {
        summary.rateLimitDeferred.push(candidate.slug);
      }
      continue;
    }

    if (!(await canConsume())) {
      summary.rateLimitDeferred.push(candidate.slug);
      continue;
    }

    try {
      await consume();
    } catch (err) {
      if (err instanceof RateLimitExceeded) {
        summary.rateLimitDeferred.push(candidate.slug);
        continue;
      }
      throw err;
    }

    // Tracking issue opens AFTER the rate-limit gate so deferred candidates
    // don't generate issue noise. Each cron run produces at most 3 issues
    // under the default cap.
    const issue = await createIssue({
      title: `🐝 ${candidate.campaignName} funded (${candidate.slug})`,
      body:
        `Auto-detected via daily cron (PostHog).\n\n` +
        `- Campaign: ${candidate.campaignName}\n` +
        `- Slug: \`${candidate.slug}\`\n` +
        `- Stage: ${candidate.campaignStage}\n` +
        `- Funded at (campaignexpirationdate): ${candidate.fundedAt}\n` +
        `- Source: https://invest.honeycombcredit.com/campaigns/${candidate.slug}`,
      labels: ['detection'],
    });
    setTrackingIssue(issue.number);

    try {
      const result = await runPipeline({ slug: candidate.slug });
      const url = `https://funded.honeycombcredit.com/${result.slug}`;
      await stage(`✅ Published — ${url}`, { commit: result.commitSha });
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
      summary.failed.push({ slug: candidate.slug, reason });
      await stage(`❌ Generation failed — ${reason}`);
      await addLabel(issue.number, 'error');
    }
    setTrackingIssue(null);
  }

  // ---- 4. Persist detection log + commit ----
  const ranAt = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  await appendDetectionLog({
    ranAt: dryRun ? `${ranAt} (dry-run)` : ranAt,
    posthogReturned: summary.posthogReturned,
    alreadyPublished: summary.alreadyPublished,
    eligible: summary.eligible.length,
    generated: summary.generated.length,
    rateLimitDeferred: summary.rateLimitDeferred.length,
    failed: summary.failed.length,
  });

  if (!dryRun) {
    await git.configureBotIdentity();
    await git.add(LOG_FILE);
    await git.commit('chore(state): append detection log');
  }

  // ---- 5. Daily summary issue (only when there's signal worth a notification) ----
  const today = new Date().toISOString().slice(0, 10);
  const summaryBody = [
    `**Daily detection — ${today}**`,
    '',
    `- PostHog returned: ${summary.posthogReturned}`,
    `- Already published: ${summary.alreadyPublished}`,
    `- Eligible (new): ${summary.eligible.length}${summary.eligible.length ? ` (${summary.eligible.map((s) => `\`${s}\``).join(', ')})` : ''}`,
    `- Generated: ${summary.generated.length}`,
    `- Rate-limit deferred: ${summary.rateLimitDeferred.length}${summary.rateLimitDeferred.length ? ` (${summary.rateLimitDeferred.map((s) => `\`${s}\``).join(', ')})` : ''}`,
    `- Failed: ${summary.failed.length}`,
    '',
    `Rate state: ${JSON.stringify(await rateStatus())}`,
  ].join('\n');

  info('detect summary', { ...summary });
  if (!dryRun && (summary.generated.length > 0 || summary.failed.length > 0)) {
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
