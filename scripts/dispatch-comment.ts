#!/usr/bin/env tsx
// =============================================================================
// scripts/dispatch-comment.ts
//
// Parses a GitHub issue/PR comment for /funded slash commands and runs the
// matching CLI. Invoked by .github/workflows/on-comment.yml.
//
// Reads from env:
//   COMMENT_BODY   — raw comment text
//   ISSUE_NUMBER   — issue or PR number (used as the tracking issue)
//   COMMENT_USER   — github login (already collaborator-checked by the workflow)
//
// Supported commands (per scope Section 6):
//   /funded generate <campaign-slug>
//   /funded redraft <case-study-slug> [feedback…]
//        Single-line feedback after the slug is passed verbatim to Claude.
//        For multi-paragraph feedback, use the "Redraft with feedback"
//        Issue Form instead.
//   /funded delete <case-study-slug>
//   /funded status
//   /funded cost-estimate <slug…>
//   /funded inspect <campaign-slug>   ← diagnostic; prints what's in __NEXT_DATA__
// =============================================================================

import { spawn } from 'node:child_process';
import { setTrackingIssue, info, error as logError, stage } from './lib/log.js';

const PREFIX = '/funded';

interface ParsedCommand {
  command: string;
  args: string[];
}

function parseFirstCommand(body: string): ParsedCommand | null {
  // Match the first line of the comment that starts with /funded.
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(PREFIX)) continue;
    const rest = trimmed.slice(PREFIX.length).trim();
    if (rest.length === 0) return null;
    const tokens = rest.split(/\s+/);
    const command = tokens[0]!;
    const args = tokens.slice(1).filter((t) => t.length > 0);
    return { command, args };
  }
  return null;
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
  const body = process.env['COMMENT_BODY'] ?? '';
  const issueRaw = process.env['ISSUE_NUMBER'] ?? '';
  const issueNumber = Number.parseInt(issueRaw, 10);
  if (Number.isNaN(issueNumber)) {
    throw new Error('ISSUE_NUMBER env var missing or invalid.');
  }
  setTrackingIssue(issueNumber);

  const parsed = parseFirstCommand(body);
  if (!parsed) {
    info('no /funded command in comment; ignoring');
    return;
  }

  info('parsed command', { command: parsed.command, args: parsed.args });
  const issueArg = `--issue=${issueNumber}`;

  switch (parsed.command) {
    case 'generate': {
      if (parsed.args.length < 1) {
        await stage('❌ `/funded generate <slug>` — missing slug.');
        process.exit(2);
      }
      await runCli('scripts/generate.ts', [parsed.args[0]!, issueArg]);
      break;
    }
    case 'redraft': {
      if (parsed.args.length < 1) {
        await stage('❌ `/funded redraft <case-study-slug> [feedback…]` — missing slug.');
        process.exit(2);
      }
      const slug = parsed.args[0]!;
      // Everything after the slug, joined with spaces, becomes the
      // feedback string. Single-line only — for multi-paragraph feedback,
      // use the "Redraft with feedback" Issue Form.
      const feedback = parsed.args.slice(1).join(' ').trim();
      const cliArgs = [slug, issueArg];
      if (feedback.length > 0) cliArgs.push(`--feedback=${feedback}`);
      await runCli('scripts/redraft.ts', cliArgs);
      break;
    }
    case 'delete': {
      if (parsed.args.length < 1) {
        await stage('❌ `/funded delete <slug>` — missing slug.');
        process.exit(2);
      }
      await runCli('scripts/delete.ts', [parsed.args[0]!, issueArg]);
      break;
    }
    case 'status': {
      await runCli('scripts/status.ts', [issueArg]);
      break;
    }
    case 'cost-estimate': {
      if (parsed.args.length < 1) {
        await stage('❌ `/funded cost-estimate <slug...>` — pass at least one slug.');
        process.exit(2);
      }
      await runCli('scripts/cost-estimate.ts', [...parsed.args, issueArg]);
      break;
    }
    case 'inspect': {
      if (parsed.args.length < 1) {
        await stage('❌ `/funded inspect <slug>` — missing slug.');
        process.exit(2);
      }
      await runCli('scripts/inspect.ts', [parsed.args[0]!, issueArg]);
      break;
    }
    default: {
      await stage(`❌ Unknown command \`/funded ${parsed.command}\`. Supported: generate, redraft, delete, status, cost-estimate, inspect.`);
      process.exit(2);
    }
  }
}

main().catch((err: unknown) => {
  logError('dispatch-comment crashed', { message: (err as Error).message });
  process.exit(1);
});
