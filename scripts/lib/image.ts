// Hero/OG image fetcher. Pulls from the campaign page's ogImageUrl and writes
// to public/og/{slug}.{ext}. Returns the path the schema's heroImage field
// should hold (e.g. "/og/brothmonger.png").

import { promises as fs } from 'node:fs';
import path from 'node:path';

const OG_DIR = path.resolve(process.cwd(), 'public/og');

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

function extFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').pop() ?? '';
    const dot = seg.lastIndexOf('.');
    if (dot === -1) return null;
    const e = seg.slice(dot + 1).toLowerCase();
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'].includes(e)) {
      return e === 'jpeg' ? 'jpg' : e;
    }
    return null;
  } catch {
    return null;
  }
}

export async function fetchAndStoreHeroImage(opts: {
  ogImageUrl: string;
  slug: string;
}): Promise<{ publicPath: string; bytes: number }> {
  const res = await fetch(opts.ogImageUrl, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (compatible; HoneycombFundedAgent/4.0; +https://funded.honeycombcredit.com)',
    },
  });
  if (!res.ok) {
    throw new Error(
      `Image fetch failed: GET ${opts.ogImageUrl} → ${res.status} ${res.statusText}`,
    );
  }

  // Prefer the URL extension; fall back to Content-Type.
  let ext = extFromUrl(opts.ogImageUrl);
  if (!ext) {
    const ct = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (ct && EXT_BY_MIME[ct]) ext = EXT_BY_MIME[ct] ?? null;
  }
  if (!ext) {
    throw new Error(
      `Could not determine image extension for ${opts.ogImageUrl} (content-type: ${res.headers.get('content-type') ?? 'unknown'}).`,
    );
  }

  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(OG_DIR, { recursive: true });
  const filename = `${opts.slug}.${ext}`;
  await fs.writeFile(path.join(OG_DIR, filename), buf);
  return { publicPath: `/og/${filename}`, bytes: buf.byteLength };
}

// Used by delete.ts to remove the hero image alongside its MDX.
export async function removeHeroImage(slug: string): Promise<string[]> {
  const exts = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'];
  const removed: string[] = [];
  for (const ext of exts) {
    const p = path.join(OG_DIR, `${slug}.${ext}`);
    try {
      await fs.unlink(p);
      removed.push(`/og/${slug}.${ext}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return removed;
}
