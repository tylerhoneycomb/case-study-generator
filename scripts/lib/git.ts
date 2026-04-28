// Minimal git wrapper using child_process. Used by the generate/redraft/
// delete CLIs to commit content changes. In CI, the workflow runs as a bot
// that has write access via GITHUB_TOKEN; locally, the user's git config
// applies.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function git(...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd: process.cwd(),
    env: process.env,
  });
  return stdout.trim();
}

export async function configureBotIdentity(): Promise<void> {
  // Set in CI only when the env var marker is present so we don't override
  // a developer's local config. The on-* workflows set FUNDED_BOT_IDENTITY=1.
  if (process.env['FUNDED_BOT_IDENTITY'] !== '1') return;
  await git('config', 'user.name', 'funded-bot');
  await git('config', 'user.email', 'funded-bot@users.noreply.github.com');
}

export async function add(...paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await git('add', '--', ...paths);
}

export async function rm(path: string): Promise<void> {
  // Use --ignore-unmatch so rm of a missing path is a no-op instead of an error.
  await git('rm', '-f', '--ignore-unmatch', '--', path);
}

export async function commit(message: string): Promise<{ committed: boolean }> {
  // Check whether anything is staged. If not, no-op.
  try {
    await git('diff', '--cached', '--quiet');
    return { committed: false };
  } catch {
    // Non-zero exit means staged changes exist.
  }
  await git('commit', '-m', message);
  return { committed: true };
}

export async function push(): Promise<void> {
  await git('push');
}

export async function commitSha(): Promise<string> {
  return git('rev-parse', 'HEAD');
}

export async function commitUrl(): Promise<string | null> {
  const slug = process.env['GITHUB_REPOSITORY'] ?? process.env['FUNDED_REPO'];
  if (!slug) return null;
  const sha = await commitSha();
  return `https://github.com/${slug}/commit/${sha}`;
}
