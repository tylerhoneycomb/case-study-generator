// Pins the PostHog client's request shape and response parsing. The cron
// depends on this module to source every funded slug; if PostHog changes
// its response envelope or auth header, the failure mode should be a
// typed PostHogError surfaced via the detection tracking issue rather
// than a silent zero-row run.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchFundedCampaigns, HOGQL_QUERY, PostHogError } from './posthog.js';

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
