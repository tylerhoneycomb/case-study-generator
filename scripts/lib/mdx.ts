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

// Find an existing case study by its source-platform campaignSlug (not by
// the case-study filename). Walks every MDX in the collection, parses
// frontmatter, returns the first match.
//
// This is what makes generate.ts idempotent on the *campaign* — the agent
// can run /funded generate <honeycomb-slug> repeatedly without producing
// duplicate MDX files even though Claude tends to pick slightly different
// case-study slugs across calls.
export async function findByCampaignSlug(
  campaignSlug: string,
): Promise<{ slug: string; path: string; frontmatter: Record<string, unknown> } | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(CONTENT_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  for (const name of entries) {
    if (!name.endsWith('.mdx')) continue;
    const slug = name.slice(0, -'.mdx'.length);
    const file = await readCaseStudy(slug);
    if (!file) continue;
    if (file.frontmatter['campaignSlug'] === campaignSlug) {
      return { slug, path: caseStudyPath(slug), frontmatter: file.frontmatter };
    }
  }
  return null;
}

// One-pass scan of every committed case study, returning the set of source
// `campaignSlug` values. Cheaper than calling findByCampaignSlug() per
// candidate during detection — one readdir + N reads instead of N * (readdir
// + N reads). Used by scripts/detect.ts to filter PostHog candidates against
// already-published campaigns before rate-limiting and issue creation.
export async function listAllCampaignSlugs(): Promise<Set<string>> {
  const out = new Set<string>();
  let entries: string[];
  try {
    entries = await fs.readdir(CONTENT_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw err;
  }
  for (const name of entries) {
    if (!name.endsWith('.mdx')) continue;
    const slug = name.slice(0, -'.mdx'.length);
    const file = await readCaseStudy(slug);
    const cs = file?.frontmatter['campaignSlug'];
    if (typeof cs === 'string' && cs) out.add(cs);
  }
  return out;
}

export const paths = {
  CONTENT_DIR,
} as const;
