// Minimal structured logger. CI-friendly (each line is one event).
// Also routes important stages to a tracking issue when issueNumber is set.

import { addComment } from './github.js';

let trackingIssueNumber: number | null = null;

export function setTrackingIssue(n: number | null): void {
  trackingIssueNumber = n;
}

function ts(): string {
  return new Date().toISOString();
}

export function info(msg: string, meta?: Record<string, unknown>): void {
  const line = meta ? `${msg} ${JSON.stringify(meta)}` : msg;
  console.log(`[${ts()}] ${line}`);
}

export function warn(msg: string, meta?: Record<string, unknown>): void {
  const line = meta ? `${msg} ${JSON.stringify(meta)}` : msg;
  console.warn(`[${ts()}] WARN ${line}`);
}

export function error(msg: string, meta?: Record<string, unknown>): void {
  const line = meta ? `${msg} ${JSON.stringify(meta)}` : msg;
  console.error(`[${ts()}] ERROR ${line}`);
}

// Post a milestone to both the local log and the tracking issue (if any).
// Used for the user-visible status comments referenced in scope Section 6.
export async function stage(msg: string, meta?: Record<string, unknown>): Promise<void> {
  info(msg, meta);
  if (trackingIssueNumber !== null) {
    try {
      const detail = meta ? `\n\n\`\`\`json\n${JSON.stringify(meta, null, 2)}\n\`\`\`` : '';
      await addComment(trackingIssueNumber, `${msg}${detail}`);
    } catch (err) {
      // Don't let comment failures break the run.
      warn('failed to post stage comment', { err: (err as Error).message });
    }
  }
}
