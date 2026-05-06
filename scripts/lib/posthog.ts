// =============================================================================
// PostHog HogQL client — discovery source for newly-funded campaigns.
//
// Replaces the listing-scrape path in scripts/detect.ts. PostHog mirrors
// Honeycomb's `postgres.campaigns` table via Fivetran, so a single HogQL
// query returns every campaign that ever transitioned to Funded — including
// the ~570 historical funded campaigns that never appeared on the
// invest.honeycombcredit.com listing window.
//
// Per-campaign content (use of proceeds, metrics, hero image, etc.) is still
// fetched via scripts/lib/scrape.ts during the pipeline. PostHog only
// answers "which slugs are funded?" — the content scrape answers "what does
// the case study say?".
//
// Auth: personal API key with project:query:read, passed as Bearer token.
// The cron workflow sources it from the POSTHOG_API_KEY repo secret.
// Project ID is supplied via POSTHOG_PROJECT_ID; cloud host (us vs eu) via
// POSTHOG_HOST, defaulting to us.posthog.com.
// =============================================================================

import { warn } from './log.js';

export interface FundedCandidate {
  slug: string;
  campaignName: string;
  campaignStage: 'Funded' | 'Successful - Finalizing';
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

// HogQL query is fixed. campaignexpirationdate is the chosen fund-date column
// (see header comment). The 2026-01-01 floor is per Tyler: pre-Jan-2026
// campaigns are deferred to manual backfill via the Issue Form, not auto-
// processed by the cron. ORDER BY ... DESC drives newest-first iteration in
// detect.ts so fresh transitions cut to the front of the rate-limit queue.
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
  // Older shape returned `types` and `hogql`; we only need results+columns.
}

function getEnv(): { apiKey: string; projectId: string; host: string } {
  const apiKey = process.env['POSTHOG_API_KEY'];
  if (!apiKey) {
    throw new PostHogError(
      'POSTHOG_API_KEY_MISSING',
      'POSTHOG_API_KEY is not set. Required for detection. Add as a repo secret.',
    );
  }
  const projectId = process.env['POSTHOG_PROJECT_ID'];
  if (!projectId) {
    throw new PostHogError(
      'POSTHOG_PROJECT_ID_MISSING',
      'POSTHOG_PROJECT_ID is not set. Required for detection. Add as a repo secret.',
    );
  }
  const host = (process.env['POSTHOG_HOST'] ?? 'https://us.posthog.com').replace(/\/$/, '');
  return { apiKey, projectId, host };
}

export async function fetchFundedCampaigns(): Promise<FundedCandidate[]> {
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
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query: HOGQL } }),
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

  const idx = {
    slug: columns.indexOf('slug'),
    campaignname: columns.indexOf('campaignname'),
    campaignstage: columns.indexOf('campaignstage'),
    fundedat: columns.indexOf('fundedat'),
  };
  if (idx.slug < 0 || idx.campaignname < 0 || idx.campaignstage < 0 || idx.fundedat < 0) {
    throw new PostHogError(
      'SHAPE',
      `Expected columns slug/campaignname/campaignstage/fundedat; got ${columns.join(',')}`,
    );
  }

  const out: FundedCandidate[] = [];
  for (const row of rows) {
    const slug = row[idx.slug];
    const campaignName = row[idx.campaignname];
    const campaignStage = row[idx.campaignstage];
    const fundedAt = row[idx.fundedat];

    if (typeof slug !== 'string' || !slug) {
      warn('posthog row skipped: missing slug', { row });
      continue;
    }
    if (campaignStage !== 'Funded' && campaignStage !== 'Successful - Finalizing') {
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
