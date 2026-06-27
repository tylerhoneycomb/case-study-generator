// Pins the PostHog client's request shape and response parsing. The cron
// depends on this module to source every funded slug; if PostHog changes
// its response envelope or auth header, the failure mode should be a
// typed PostHogError surfaced via the detection tracking issue rather
// than a silent zero-row run.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchFundedCampaigns,
  resolveCampaignsByName,
  HOGQL_QUERY,
  PostHogError,
} from './posthog.js';

const OK_BODY = {
  columns: ['slug', 'campaignname', 'campaignstage', 'fundedat'],
  results: [
    ['Slutty-Vegan', 'Slutty Vegan', 'Funded', '2026-04-27'],
    ['The-Onion-Tree', 'The Onion Tree', 'Successful - Finalizing', '2026-04-20'],
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchFundedCampaigns', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    process.env['POSTHOG_API_KEY'] = 'phx_test_key';
    process.env['POSTHOG_PROJECT_ID'] = '12345';
    delete process.env['POSTHOG_HOST'];
  });
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env['POSTHOG_API_KEY'];
    delete process.env['POSTHOG_PROJECT_ID'];
    delete process.env['POSTHOG_HOST'];
  });

  it('POSTs HogQL to /api/projects/<id>/query/ with bearer auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(OK_BODY));
    global.fetch = fetchMock as unknown as typeof fetch;

    await fetchFundedCampaigns();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://us.posthog.com/api/projects/12345/query/');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer phx_test_key');
    expect(init.headers['content-type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body.query.kind).toBe('HogQLQuery');
    expect(body.query.query).toBe(HOGQL_QUERY);
    // Sanity: the query targets the right table + filter floor.
    expect(body.query.query).toContain('FROM postgres.campaigns');
    expect(body.query.query).toContain("'2026-01-01'");
    expect(body.query.query).toContain('ORDER BY campaignexpirationdate DESC');
  });

  it('honours POSTHOG_HOST override (e.g. EU cloud)', async () => {
    process.env['POSTHOG_HOST'] = 'https://eu.posthog.com/';
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(OK_BODY));
    global.fetch = fetchMock as unknown as typeof fetch;

    await fetchFundedCampaigns();

    const [url] = fetchMock.mock.calls[0]!;
    // Trailing slash is stripped so we don't end up with a double slash.
    expect(url).toBe('https://eu.posthog.com/api/projects/12345/query/');
  });

  it('parses well-formed rows into typed candidates, preserving order', async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(OK_BODY)) as unknown as typeof fetch;

    const candidates = await fetchFundedCampaigns();

    expect(candidates).toEqual([
      {
        slug: 'Slutty-Vegan',
        campaignName: 'Slutty Vegan',
        campaignStage: 'Funded',
        fundedAt: '2026-04-27',
      },
      {
        slug: 'The-Onion-Tree',
        campaignName: 'The Onion Tree',
        campaignStage: 'Successful - Finalizing',
        fundedAt: '2026-04-20',
      },
    ]);
  });

  it('skips rows with missing slug or unexpected stage', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        columns: ['slug', 'campaignname', 'campaignstage', 'fundedat'],
        results: [
          ['', 'Empty Slug', 'Funded', '2026-04-27'],
          ['Closed-Co', 'Closed Co', 'Closed', '2026-04-26'],
          ['Real-One', 'Real One', 'Funded', '2026-04-25'],
        ],
      }),
    ) as unknown as typeof fetch;

    const candidates = await fetchFundedCampaigns();

    expect(candidates.map((c) => c.slug)).toEqual(['Real-One']);
  });

  it('throws PostHogError(POSTHOG_API_KEY_MISSING) when key is unset', async () => {
    delete process.env['POSTHOG_API_KEY'];
    await expect(fetchFundedCampaigns()).rejects.toMatchObject({
      name: 'POSTHOG_API_KEY_MISSING',
    });
  });

  it('throws PostHogError(HTTP) on non-2xx responses', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response('forbidden', { status: 403 }),
    ) as unknown as typeof fetch;

    await expect(fetchFundedCampaigns()).rejects.toBeInstanceOf(PostHogError);
    await expect(fetchFundedCampaigns()).rejects.toMatchObject({ name: 'HTTP' });
  });

  it('throws PostHogError(SHAPE) when response is missing results/columns', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ unexpected: 'shape' }),
    ) as unknown as typeof fetch;

    await expect(fetchFundedCampaigns()).rejects.toMatchObject({ name: 'SHAPE' });
  });
});

// Pins the cheap "find the business" resolver: one free PostHog query turns
// operator-supplied names into slugs + fundability, with no Anthropic spend
// and no GitHub Actions run. The classification (found / ambiguous /
// fundable) is the gate that keeps doomed generations from ever dispatching.
const RESOLVE_COLUMNS = ['slug', 'campaignname', 'campaignstage', 'fundedat'];
function resolveBody(rows: unknown[][]): Response {
  return new Response(JSON.stringify({ columns: RESOLVE_COLUMNS, results: rows }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('resolveCampaignsByName', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    process.env['POSTHOG_API_KEY'] = 'phx_test_key';
    process.env['POSTHOG_PROJECT_ID'] = '12345';
    delete process.env['POSTHOG_HOST'];
  });
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env['POSTHOG_API_KEY'];
    delete process.env['POSTHOG_PROJECT_ID'];
    delete process.env['POSTHOG_HOST'];
  });

  it('returns [] without calling fetch when no names supplied', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(resolveCampaignsByName([])).resolves.toEqual([]);
    await expect(resolveCampaignsByName(['   '])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs HogQL with ILIKE predicates for each name, bearer auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(resolveBody([]));
    global.fetch = fetchMock as unknown as typeof fetch;

    await resolveCampaignsByName(['The Ladies Room', 'Sigma Snacks']);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://us.posthog.com/api/projects/12345/query/');
    expect(init.headers.authorization).toBe('Bearer phx_test_key');
    const body = JSON.parse(init.body as string);
    expect(body.query.kind).toBe('HogQLQuery');
    expect(body.query.query).toContain('FROM postgres.campaigns');
    expect(body.query.query).toContain("campaignname ILIKE '%The Ladies Room%'");
    expect(body.query.query).toContain("slug ILIKE '%the-ladies-room%'");
    expect(body.query.query).toContain("campaignname ILIKE '%Sigma Snacks%'");
  });

  it('classifies a single fundable match', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      resolveBody([['Sensi-Fit', 'Sensi Fit', 'Funded', '2025-04-24']]),
    ) as unknown as typeof fetch;

    const r = (await resolveCampaignsByName(['Sensi Fit']))[0]!;
    expect(r).toMatchObject({
      query: 'Sensi Fit',
      found: true,
      ambiguous: false,
      fundable: true,
      match: { slug: 'Sensi-Fit', campaignStage: 'Funded', fundedAt: '2025-04-24' },
    });
  });

  it('marks a matched-but-not-funded campaign as not fundable', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      resolveBody([['Closed-Co', 'Closed Co', 'Unsuccessful', '2025-01-01']]),
    ) as unknown as typeof fetch;

    const r = (await resolveCampaignsByName(['Closed Co']))[0]!;
    expect(r.found).toBe(true);
    expect(r.fundable).toBe(false);
    expect(r.match?.campaignStage).toBe('Unsuccessful');
  });

  it('accepts "Successful - Finalizing" as fundable', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      resolveBody([['Late-Co', 'Late Co', 'Successful - Finalizing', '2026-02-02']]),
    ) as unknown as typeof fetch;

    const r = (await resolveCampaignsByName(['Late Co']))[0]!;
    expect(r.fundable).toBe(true);
  });

  it('reports a name with no matching row as not found', async () => {
    global.fetch = vi.fn().mockResolvedValue(resolveBody([])) as unknown as typeof fetch;

    const r = (await resolveCampaignsByName(['Does Not Exist']))[0]!;
    expect(r).toMatchObject({ found: false, ambiguous: false, fundable: false });
    expect(r.candidates).toEqual([]);
  });

  it('flags ambiguous names (>1 match) and does not mark them fundable', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      resolveBody([
        ['Sigma-Snacks', 'Sigma Snacks', 'Funded', '2024-04-13'],
        ['Sigma-Sports', 'Sigma Sports', 'Funded', '2024-06-01'],
      ]),
    ) as unknown as typeof fetch;

    const r = (await resolveCampaignsByName(['Sigma']))[0]!;
    expect(r.found).toBe(true);
    expect(r.ambiguous).toBe(true);
    expect(r.fundable).toBe(false);
    expect(r.candidates).toHaveLength(2);
    expect(r.match).toBeUndefined();
  });

  it('attributes each row to the right name in a batch and isolates non-matches', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      resolveBody([
        ['The-Ladies-Room', 'The Ladies Room', 'Funded', '2024-10-31'],
        ['Sigma-Snacks', 'Sigma Snacks', 'Funded', '2024-04-13'],
      ]),
    ) as unknown as typeof fetch;

    const results = await resolveCampaignsByName(['The Ladies Room', 'Sigma Snacks', 'Phantom Biz']);
    expect(results.map((r) => [r.query, r.fundable, r.match?.slug ?? null])).toEqual([
      ['The Ladies Room', true, 'The-Ladies-Room'],
      ['Sigma Snacks', true, 'Sigma-Snacks'],
      ['Phantom Biz', false, null],
    ]);
  });

  it('escapes single quotes and backslashes in names (no literal break / injection)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(resolveBody([]));
    global.fetch = fetchMock as unknown as typeof fetch;

    await resolveCampaignsByName(["O'Briens", 'Back\\slash']);

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    // Single quote doubled, backslash doubled — the closing quote of each
    // string literal stays intact.
    expect(body.query.query).toContain("campaignname ILIKE '%O''Briens%'");
    expect(body.query.query).toContain("campaignname ILIKE '%Back\\\\slash%'");
  });

  it('throws PostHogError when the API key is missing', async () => {
    delete process.env['POSTHOG_API_KEY'];
    await expect(resolveCampaignsByName(['Anything'])).rejects.toBeInstanceOf(PostHogError);
  });
});
