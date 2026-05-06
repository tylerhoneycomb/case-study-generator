#!/usr/bin/env tsx
// =============================================================================
// scripts/status.ts [--issue=N]
//
// Replies (in the tracking issue, if --issue is set; otherwise stdout) with
// today's queue depth, rate-limit usage, and last cron run.
// Invoked by the on-comment workflow when someone types `/funded status`.
// =============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseArgs } from './lib/args.js';
import { setTrackingIssue, info, error as logError, stage } from './lib/log.js';
import { status as rateStatus } from './lib/ratelimit.js';

async function lastDetectionMtime(): Promise<string | null> {
  // Detection log is appended on every cron run (including dry-run and zero-
  // activity days), so its mtime is the truthiest "did the cron run lately"
  // signal we have committed to the repo.
  const f = path.resolve(process.cwd(), '.state/detection-log.md');
  try {
    const s = await fs.stat(f);
    return s.mtime.toISOString();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const issueRaw = args.values['issue'];
  const issueNumber = issueRaw ? Number.parseInt(issueRaw, 10) : null;

  if (issueNumber !== null && !Number.isNaN(issueNumber)) {
    setTrackingIssue(issueNumber);
  }

  const rate = await rateStatus();
  const lastDetect = await lastDetectionMtime();

  const body = [
    `**funded.honeycombcredit.com — status**`,
    '',
    `- Rate limit: ${rate.used}/${rate.cap} used today (${rate.remaining} remaining, ${rate.date} UTC)`,
    `- Last detection state file mtime: ${lastDetect ?? 'never'}`,
    `- Run \`/funded cost-estimate <slug…>\` to estimate generation cost without spending.`,
  ].join('\n');

  info('status report', { rate, lastDetect });
  await stage(body);
}

main().catch((err: unknown) => {
  logError('status crashed', { message: (err as Error).message });
  process.exit(1);
});
