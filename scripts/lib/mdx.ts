// MDX file writer/reader. Frontmatter is YAML; body is the rich-text HTML
// from Claude (MDX accepts HTML inline). Generation always overwrites; the
// caller is responsible for the upstream "skip if exists unless --force"
// logic in backfill.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const CONTENT_DIR = path.resolve(process.cwd(), 'src/content/case-studies');

export interface MdxFile<F extends Record<string, unknown>> {
  frontmatter: F;
  body: string;
}

export function caseStudyPath(slug: string): string {
  return path.join(CONTENT_DIR, `${slug}.mdx`);
}

export async function exists(slug: string): Promise<boolean> {
  try {
    await fs.access(caseStudyPath(slug));
    return true;
  } catch {
    return false;
  }
}

export async function writeCaseStudy(opts: {
  slug: string;
  frontmatter: Record<string, unknown>;
  body: string;
}): Promise<{ path: string }> {
  await fs.mkdir(CONTENT_DIR, { recursive: true });
  const yaml = YAML.stringify(opts.frontmatter, {
    // Force quoted strings on values that contain : or # to avoid YAML
    // parsing surprises. Block style for nested JSON-LD readability.
    defaultStringType: 'PLAIN',
    defaultKeyType: 'PLAIN',
    lineWidth: 0,
  });
  const file = `---\n${yaml}---\n\n${opts.body.trim()}\n`;
  const filePath = caseStudyPath(opts.slug);
  await fs.writeFile(filePath, file, 'utf8');
  return { path: filePath };
}

// Read raw MDX (frontmatter as parsed YAML + body string). Used by redraft
// to inspect a previously-generated file before regenerating.
export async function readCaseStudy(
  slug: string,
): Promise<{ frontmatter: Record<string, unknown>; body: string } | null> {
  const filePath = caseStudyPath(slug);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const m = raw.match(/^---\n([\s\S]*?)\n---\n+([\s\S]*)$/);
  if (!m) return null;
  const fmStr = m[1] ?? '';
  const body = m[2] ?? '';
  const frontmatter = YAML.parse(fmStr) as Record<string, unknown>;
  return { frontmatter, body };
}

export async function deleteCaseStudy(slug: string): Promise<boolean> {
  try {
    await fs.unlink(caseStudyPath(slug));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export const paths = {
  CONTENT_DIR,
} as const;
