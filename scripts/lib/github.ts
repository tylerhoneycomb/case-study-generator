// =============================================================================
// GitHub API helpers — wraps Octokit for the issue/comment surface that the
// agent uses as its audit log and control plane.
//
// In CI the workflows pass GITHUB_TOKEN. Locally, set GITHUB_TOKEN to a PAT
// with issues:write on the repo. Repo identity is taken from
// GITHUB_REPOSITORY ("owner/repo") which Actions sets automatically; locally
// you can set FUNDED_REPO instead.
// =============================================================================

import { Octokit } from '@octokit/rest';

interface RepoIdent {
  owner: string;
  repo: string;
}

function getRepo(): RepoIdent {
  const slug =
    process.env['GITHUB_REPOSITORY'] ?? process.env['FUNDED_REPO'] ?? '';
  const [owner, repo] = slug.split('/');
  if (!owner || !repo) {
    throw new Error(
      'Repo not specified. In CI, GITHUB_REPOSITORY is auto-set. Locally, set FUNDED_REPO=<owner>/<repo>.',
    );
  }
  return { owner, repo };
}

function getClient(): Octokit {
  const token = process.env['GITHUB_TOKEN'];
  if (!token) {
    throw new Error('GITHUB_TOKEN is not set. Required for issue/comment operations.');
  }
  return new Octokit({ auth: token });
}

export interface IssueRef {
  number: number;
  url: string;
}

export async function createIssue(opts: {
  title: string;
  body: string;
  labels?: string[];
}): Promise<IssueRef> {
  const { owner, repo } = getRepo();
  const client = getClient();
  const res = await client.issues.create({
    owner,
    repo,
    title: opts.title,
    body: opts.body,
    labels: opts.labels,
  });
  return { number: res.data.number, url: res.data.html_url };
}

export async function addComment(issueNumber: number, body: string): Promise<void> {
  const { owner, repo } = getRepo();
  await getClient().issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
}

export async function addLabel(issueNumber: number, label: string): Promise<void> {
  const { owner, repo } = getRepo();
  await getClient().issues.addLabels({
    owner,
    repo,
    issue_number: issueNumber,
    labels: [label],
  });
}

export async function removeLabel(issueNumber: number, label: string): Promise<void> {
  const { owner, repo } = getRepo();
  try {
    await getClient().issues.removeLabel({
      owner,
      repo,
      issue_number: issueNumber,
      name: label,
    });
  } catch (err) {
    // 404 means the label wasn't applied — not a failure.
    const status = (err as { status?: number }).status;
    if (status !== 404) throw err;
  }
}

export async function closeIssue(issueNumber: number, reason: 'completed' | 'not_planned' = 'completed'): Promise<void> {
  const { owner, repo } = getRepo();
  await getClient().issues.update({
    owner,
    repo,
    issue_number: issueNumber,
    state: 'closed',
    state_reason: reason,
  });
}

// ---------------------------------------------------------------------------
// Collaborator check — the auth boundary for /funded slash commands.
// Returns true if the user has push or admin permission on the repo.
// ---------------------------------------------------------------------------
export async function isCollaborator(username: string): Promise<boolean> {
  const { owner, repo } = getRepo();
  try {
    const res = await getClient().repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username,
    });
    const level = res.data.permission;
    return level === 'admin' || level === 'write';
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) return false;
    throw err;
  }
}

// Convenience: stamp a tracking issue with a stage transition comment.
export async function postStage(issueNumber: number, stage: string, detail?: string): Promise<void> {
  const body = detail ? `**${stage}** — ${detail}` : `**${stage}**`;
  await addComment(issueNumber, body);
}
