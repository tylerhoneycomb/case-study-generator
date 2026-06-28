// =============================================================================
// PostHog HogQL client — discovery + name-resolution source for campaigns.
//
// Two public functions, both backed by the same Fivetran-mirrored
// `postgres.campaigns` table and the same query endpoint:
//
//   fetchFundedCampaigns()      — the daily-cron discovery query: every
//                                 campaign funded on/after 2026-01-01,
//                                 newest first. Drives detect.ts.
//
//   resolveCampaignsByName()    — turn operator-supplied business *names*
//                                 into exact campaign *slugs* + funding
//                                 stage. This is the cheap "find the
//                                 business" mechanism: one free PostHog
//                                 query, NO Anthropic spend, NO GitHub
//                                 Actions run. Run it BEFORE dispatching a
//                                 generation so we never fire a doomed
//                                 pipeline (and burn an Actions minute)
//                                 against a name that doesn't exist or a
//                                 campaign that never funded.
//
// Per-campaign content (use of proceeds, metrics, hero image, etc.) is
// still scraped from invest.honeycombcredit.com inside pipeline.ts. PostHog
// only answers "does this exist / is it funded / what's the slug?".
//
// Auth: personal API key with project:query:read, passed as a Bearer token.
// POSTHOG_API_KEY + POSTHOG_PROJECT_ID come from repo secrets / local env;
// cloud host (us vs eu) via POSTHOG_HOST, defaulting to us.posthog.com.
// =============================================================================

import { warn } from './log.js';

// The two campaign stages that warrant a published case study. Shared by the
// discovery query, the discovery-row validation, and the name resolver's
// `fundable` classification so the definition lives in exactly one place.
export const FUNDABLE_STAGES = ['Funded', 'Successful - Finalizing'] as const;
export type FundableStage = (typeof FUNDABLE_STAGES)[number];

function isFundableStage(s: unknown): s is FundableStage {
  return typeof s === 'string' && (FUNDABLE_STAGES as readonly string[]).includes(s);
}

export interface FundedCandidate {
  slug: string;
  campaignName: string;
  campaignStage: FundableStage;
  // ISO date string from campaignexpirationdate (the scheduled close date
  // of the fundraising window). Tyler ruled out updatedat as noisy: old
  // Funded records get touched for admin/repayment reasons unrelated to
  // the funding event. campaignexpirationdate is the cleanest proxy for
  // "when did this campaign finish raising."
  fundedAt: string;
}

export class PostHogError extends Error {
  constructor(public override readonly name: string, message: string) {
    super(message);
  }
}

// Discovery query is fixed. campaignexpirationdate is the chosen fund-date
// column. The 2026-01-01 floor is per Tyler: pre-Jan-2026 campaigns are
// deferred to manual backfill via the Issue Form / the resolver below, not
// auto-processed by the cron. ORDER BY ... DESC drives newest-first
// iteration in detect.ts so fresh transitions cut to the front of the queue.
const HOGQL = `
  SELECT slug, campaignname, campaignstage, campaignexpirationdate AS fundedat
  FROM postgres.campaigns
  WHERE campaignstage IN ('Funded', 'Successful - Finalizing')
    AND _fivetran_deleted = false
    AND deletedat IS NULL
    AND campaignexpirationdate >= '2026-01-01'
  ORDER BY campaignexpirationdate DESC
  LIMIT 1000
`.trim();

// Exposed for tests so the request-shape assertion can match exactly.
export const HOGQL_QUERY = HOGQL;

interface PostHogQueryResponse {
  results?: unknown[][];
  columns?: string[];
}

function getEnv(): { apiKey: string; projectId: string; host: string } {
  const apiKey = process.env['POSTHOG_API_KEY'];
  if (!apiKey) {
    throw new PostHogError(
      'POSTHOG_API_KEY_MISSING',
      'POSTHOG_API_KEY is not set. Required for detection/resolution. Add as a repo secret or local env var.',
    );
  }
  const projectId = process.env['POSTHOG_PROJECT_ID'];
  if (!projectId) {
    throw new PostHogError(
      'POSTHOG_PROJECT_ID_MISSING',
      'POSTHOG_PROJECT_ID is not set. Required for detection/resolution. Add as a repo secret or local env var.',
    );
  }
  const host = (process.env['POSTHOG_HOST'] ?? 'https://us.posthog.com').replace(/\/$/, '');
  return { apiKey, projectId, host };
}

// Single source of the endpoint/auth/parse logic. Both public functions go
// through here. Returns the raw columns + rows; callers map by column name.
async function runHogQL(query: string): Promise<{ columns: string[]; rows: unknown[][] }> {
  const { apiKey, projectId, host } = getEnv();
  const url = `${host}/api/projects/${encodeURIComponent(projectId)}/query/`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
    });
  } catch (err) {
    throw new PostHogError('NETWORK', `PostHog request failed: ${(err as Error).message}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new PostHogError('HTTP', `PostHog ${res.status}: ${body.slice(0, 500)}`);
  }

  let payload: PostHogQueryResponse;
  try {
    payload = (await res.json()) as PostHogQueryResponse;
  } catch (err) {
    throw new PostHogError('PARSE', `Response was not valid JSON: ${(err as Error).message}`);
  }

  const rows = payload.results;
  const columns = payload.columns;
  if (!Array.isArray(rows) || !Array.isArray(columns)) {
    throw new PostHogError(
      'SHAPE',
      `Expected { results: [], columns: [] }; got keys: ${Object.keys(payload ?? {}).join(',')}`,
    );
  }
  return { columns, rows };
}

function columnIndex(columns: string[], names: string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  for (const n of names) idx[n] = columns.indexOf(n);
  const missing = names.filter((n) => idx[n]! < 0);
  if (missing.length) {
    throw new PostHogError(
      'SHAPE',
      `Expected columns ${names.join('/')}; missing ${missing.join('/')} (got ${columns.join(',')})`,
    );
  }
  return idx;
}

export async function fetchFundedCampaigns(): Promise<FundedCandidate[]> {
  const { columns, rows } = await runHogQL(HOGQL);
  const idx = columnIndex(columns, ['slug', 'campaignname', 'campaignstage', 'fundedat']);

  const out: FundedCandidate[] = [];
  for (const row of rows) {
    const slug = row[idx['slug']!];
    const campaignName = row[idx['campaignname']!];
    const campaignStage = row[idx['campaignstage']!];
    const fundedAt = row[idx['fundedat']!];

    if (typeof slug !== 'string' || !slug) {
      warn('posthog row skipped: missing slug', { row });
      continue;
    }
    if (!isFundableStage(campaignStage)) {
      warn('posthog row skipped: unexpected stage', { slug, campaignStage });
      continue;
    }
    out.push({
      slug,
      campaignName: typeof campaignName === 'string' ? campaignName : slug,
      campaignStage,
      fundedAt: typeof fundedAt === 'string' ? fundedAt : '',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Name resolution — the cheap "find the business" mechanism.
// ---------------------------------------------------------------------------

export interface ResolvedCampaign {
  slug: string;
  campaignName: string;
  campaignStage: string; // raw stage, any value (not just fundable ones)
  fundedAt: string;
}

export interface NameResolution {
  // The operator-supplied name, verbatim.
  query: string;
  // At least one campaign matched the name.
  found: boolean;
  // More than one campaign matched — operator must disambiguate by slug.
  ambiguous: boolean;
  // Exactly one match AND that match is in a fundable stage. Only when this
  // is true should the caller dispatch a generation unattended.
  fundable: boolean;
  // The single match (present iff found && !ambiguous).
  match?: ResolvedCampaign;
  // Every campaign that matched the name (1 when unambiguous, >1 when not,
  // 0 when not found). Lets the caller surface options on an ambiguous hit.
  candidates: ResolvedCampaign[];
}

// Escape a value for safe interpolation into a single-quoted HogQL/ClickHouse
// string literal. Names are operator-supplied free text. Escape backslashes
// first (so we don't double-process the ones we add), then single quotes —
// both are literal-terminating in ClickHouse, so a name ending in `\` or
// containing `'` must be neutralized or it breaks (or injects into) the query.
function sqlLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "''");
}

// Slug form of a name: lowercase words joined by hyphens. Used as a second
// match axis so "Sensi Fit" also matches slug "Sensi-Fit".
function slugForm(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

// A usable search name has at least one alphanumeric character. A
// punctuation-only token ("&", "-", "'") would otherwise build an
// over-broad ILIKE '%&%' that matches most rows and reports spurious
// ambiguity; we treat such tokens as not-found and never query for them.
function hasAlnum(name: string): boolean {
  return /[a-z0-9]/i.test(name);
}

// Does a returned campaign belong to this input name? Case-insensitive
// substring on either the display name or the slug. (The SQL already
// narrowed to rows matching *some* name; this attributes each row back to
// the specific name that produced it when several were queried at once.)
function nameMatchesCampaign(name: string, c: ResolvedCampaign): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return false;
  return (
    c.campaignName.toLowerCase().includes(n) ||
    c.slug.toLowerCase().includes(slugForm(name))
  );
}

// Resolve a batch of business names to campaign slugs + stages in ONE free
// PostHog query. No Anthropic, no GitHub Actions. Non-existent names come
// back with found:false; matched-but-not-funded names come back fundable:
// false; multiple matches come back ambiguous:true with candidates listed.
export async function resolveCampaignsByName(names: string[]): Promise<NameResolution[]> {
  const cleaned = names.map((n) => n.trim()).filter(Boolean);
  if (cleaned.length === 0) return [];

  // Only names with real content get a query predicate. Punctuation-only
  // tokens are reported not-found below without ever hitting PostHog.
  const usable = cleaned.filter(hasAlnum);

  let all: ResolvedCampaign[] = [];
  if (usable.length > 0) {
    // One OR-predicate per usable name, matching either the display name or
    // the hyphenated slug form. ILIKE is case-insensitive substring in HogQL.
    const predicates = usable
      .map((n) => {
        const nameLike = `%${sqlLiteral(n)}%`;
        const slugLike = `%${sqlLiteral(slugForm(n))}%`;
        return `(campaignname ILIKE '${nameLike}' OR slug ILIKE '${slugLike}')`;
      })
      .join(' OR ');

    const query = `
      SELECT slug, campaignname, campaignstage, campaignexpirationdate AS fundedat
      FROM postgres.campaigns
      WHERE _fivetran_deleted = false
        AND deletedat IS NULL
        AND (${predicates})
      ORDER BY campaignname
      LIMIT 500
    `.trim();

    const { columns, rows } = await runHogQL(query);
    const idx = columnIndex(columns, ['slug', 'campaignname', 'campaignstage', 'fundedat']);

    all = [];
    for (const row of rows) {
      const slug = row[idx['slug']!];
      if (typeof slug !== 'string' || !slug) {
        warn('posthog resolve row skipped: missing slug', { row });
        continue;
      }
      const campaignName = row[idx['campaignname']!];
      const campaignStage = row[idx['campaignstage']!];
      const fundedAt = row[idx['fundedat']!];
      all.push({
        slug,
        campaignName: typeof campaignName === 'string' ? campaignName : slug,
        campaignStage: typeof campaignStage === 'string' ? campaignStage : '',
        fundedAt: typeof fundedAt === 'string' ? fundedAt : '',
      });
    }
  }

  return cleaned.map((query): NameResolution => {
    // Punctuation-only token: nothing meaningful to resolve.
    if (!hasAlnum(query)) {
      return { query, found: false, ambiguous: false, fundable: false, candidates: [] };
    }
    const candidates = all.filter((c) => nameMatchesCampaign(query, c));
    if (candidates.length === 0) {
      return { query, found: false, ambiguous: false, fundable: false, candidates: [] };
    }
    if (candidates.length > 1) {
      return { query, found: true, ambiguous: true, fundable: false, candidates };
    }
    const match = candidates[0]!;
    return {
      query,
      found: true,
      ambiguous: false,
      fundable: isFundableStage(match.campaignStage),
      match,
      candidates,
    };
  });
}
