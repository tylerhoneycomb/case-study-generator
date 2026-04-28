#!/usr/bin/env tsx
// =============================================================================
// scripts/delete.ts <slug> [--issue=N]
//
// Remove a published case study. git rm the MDX file, delete the hero image,
// commit. Used by /funded delete <slug> as the safety net for
// auto-generated content that needs to come down.
// =============================================================================

import { parseArgs, requirePositional } from './lib/args.js';
import { setTrackingIssue, info, error as logError, stage } from './lib/log.js';
import { caseStudyPath, exists } from './lib/mdx.js';
import { removeHeroImage } from './lib/image.js';
import * as git from './lib/git.js';
import { addLabel, closeIssue } from './lib/github.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const slug = requirePositional(args, 0, '<slug>');
  const issueRaw = args.values['issue'];
  const issueNumber = issueRaw ? Number.parseInt(issueRaw, 10) : null;

  if (issueNumber !== null && !Number.isNaN(issueNumber)) {
    setTrackingIssue(issueNumber);
  }

  info('delete start', { slug });

  if (!(await exists(slug))) {
    await stage(`⚠️ No case study found for \`${slug}\` — nothing to delete.`);
    process.exit(0);
  }

  await git.configureBotIdentity();

  // git rm the MDX
  const mdxPath = caseStudyPath(slug);
  await git.rm(mdxPath);

  // Delete and stage hero image(s) for any extension
  const removedImages = await removeHeroImage(slug);
  for (const p of removedImages) {
    // Delete on disk handled by removeHeroImage; stage the deletion via git rm
    await git.rm(`public${p}`);
  }

  const result = await git.commit(`chore(case-study): delete ${slug}`);
  if (!result.committed) {
    await stage(`⚠️ delete had no staged changes for \`${slug}\``);
    process.exit(0);
  }
  const sha = await git.commitSha();
  await stage(`🗑️ Deleted \`${slug}\``, { commit: sha, removedImages });

  if (issueNumber !== null && !Number.isNaN(issueNumber)) {
    await addLabel(issueNumber, 'deleted');
    await closeIssue(issueNumber, 'completed');
  }
}

main().catch((err: unknown) => {
  logError('delete crashed', { message: (err as Error).message });
  process.exit(1);
});
