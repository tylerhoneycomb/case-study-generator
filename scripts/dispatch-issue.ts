#!/usr/bin/env tsx
// =============================================================================
// scripts/dispatch-issue.ts
//
// Parses an Issue Form submission and dispatches to the matching CLI.
// Invoked by .github/workflows/on-issue.yml.
//
// Reads from env:
//   ISSUE_NUMBER   — the issue's number
//   ISSUE_TITLE    — the issue title (used for routing — robust against the
//                    silent-label-drop GitHub does when an Issue Form's
//                    `labels:` list contains labels that don't yet exist in
//                    the repo)
//   ISSUE_BODY     — the rendered issue body (Issue Forms produce a
//                    structured Markdown body with `### Field name` headers)
//
// Routing (by title prefix):
//   "[Backfill] …"  → scripts/backfill.ts
//   "[Redraft] …"   → scripts/redraft.ts
//
// The Issue Form rendering convention:
//   ### Field label
//
//   <value>
//
// Checkbox fields render as `- [x] label` / `- [ ] label`.
// =============================================================================

import { spawn } from 'node:child_process';
import { setTrackingIssue, info, error as logError, stage } from './lib/log.js';

interface IssueFormFields {
  // Map of normalized-label → raw value block.
  [label: string]: string;
}

function parseFormBody(body: string): IssueFormFields {
  // Split on h3 headings. Issue Forms emit `### <label>` exactly.
  const fields: IssueFormFields = {};
  const re = /^###\s+(.+?)\s*$/gm;
  const headers: { label: string; index: number; endOfHeading: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    headers.push({ label: m[1]!.trim(), index: m.index, endOfHeading: re.lastIndex });
  }
  for (let i = 0; i < headers.length; i++) {
    const cur = headers[i]!;
    const next = headers[i + 1];
    const start = cur.endOfHeading;
    const end = next ? next.index : body.length;
    fields[normalize(cur.label)] = body.slice(start, end).trim();
  }
  return fields;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function isChecked(value: string): boolean {
  return /^\s*-\s*\[\s*[xX]\s*\]/m.test(value);
}

async function runCli(scriptPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', scriptPath, ...args], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${scriptPath} exited ${code}`));
    });
    child.on('error', reject);
  });
}

async function main(): Promise<void> {
  const body = process.env['ISSUE_BODY'] ?? '';
  const title = process.env['ISSUE_TITLE'] ?? '';
  const issueRaw = process.env['ISSUE_NUMBER'] ?? '';
  const issueNumber = Number.parseInt(issueRaw, 10);
  if (Number.isNaN(issueNumber)) throw new Error('ISSUE_NUMBER env var missing or invalid.');
  setTrackingIssue(issueNumber);

  const issueArg = `--issue=${issueNumber}`;

  if (title.startsWith('[Backfill]')) {
    await runBackfill(body, issueArg);
    return;
  }
  if (title.startsWith('[Redraft]')) {
    await runRedraft(body, issueArg);
    return;
  }
  info('title prefix did not match any form; ignoring', { title });
}

async function runBackfill(body: string, issueArg: string): Promise<void> {
  const fields = parseFormBody(body);
  const slugsRaw = fields['slugs'] ?? '';
  if (!slugsRaw) {
    await stage('❌ Backfill form is missing slugs.');
    process.exit(2);
  }
  const force = isChecked(fields['force-regenerate'] ?? '');
  const dryRun = isChecked(fields['dry-run'] ?? '');
  const rateRaw = (fields['rate-override-per-day-1-10'] ?? fields['rate-override'] ?? '').trim();
  const rate = rateRaw && /^\d+$/.test(rateRaw) ? rateRaw : '';

  const args = [`--slugs=${slugsRaw}`, issueArg];
  if (force) args.push('--force');
  if (dryRun) args.push('--dry-run');
  if (rate) args.push(`--rate=${rate}`);

  await runCli('scripts/backfill.ts', args);
}

async function runRedraft(body: string, issueArg: string): Promise<void> {
  const fields = parseFormBody(body);
  const slug = (fields['slug'] ?? '').trim();
  const feedback = (fields['feedback'] ?? '').trim();
  if (!slug || !feedback) {
    await stage('❌ Redraft form is missing slug or feedback.');
    process.exit(2);
  }
  await runCli('scripts/redraft.ts', [slug, `--feedback=${feedback}`, issueArg]);
}

main().catch((err: unknown) => {
  logError('dispatch-issue crashed', { message: (err as Error).message });
  process.exit(1);
});

