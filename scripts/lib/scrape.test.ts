import { describe, expect, it } from 'vitest';
import { isFunded, isFundraising, isCampaignSuccessful, extractHeroImageUrl } from './scrape.js';
import type { Campaign } from './schemas.js';

function makeCampaign(overrides: Partial<Campaign> & Record<string, unknown>): Campaign {
  return {
    slug: 'test',
    campaignName: 'Test',
    campaignId: '00000000-0000-0000-0000-000000000000',
    campaignStage: 'Funded',
    ...overrides,
  } as Campaign;
}

describe('campaign-stage classifiers', () => {
  describe('isFunded', () => {
    it('matches "Funded" exactly', () => {
      expect(isFunded('Funded')).toBe(true);
      expect(isFunded('  funded  ')).toBe(true);
    });
    it('does not match other success-adjacent stages', () => {
      expect(isFunded('Successful - Finalizing')).toBe(false);
      expect(isFunded('Fundraising')).toBe(false);
      expect(isFunded('')).toBe(false);
    });
  });

  describe('isFundraising', () => {
    it('matches "Fundraising" exactly', () => {
      expect(isFundraising('Fundraising')).toBe(true);
      expect(isFundraising('FUNDRAISING')).toBe(true);
    });
    it('rejects everything else', () => {
      expect(isFundraising('Funded')).toBe(false);
      expect(isFundraising('Closed')).toBe(false);
    });
  });

  describe('isCampaignSuccessful', () => {
    it('accepts "Funded"', () => {
      expect(isCampaignSuccessful('Funded')).toBe(true);
    });
    it('accepts "Successful - Finalizing"', () => {
      expect(isCampaignSuccessful('Successful - Finalizing')).toBe(true);
      // Case-insensitive defense against upstream casing drift.
      expect(isCampaignSuccessful('successful - finalizing')).toBe(true);
      expect(isCampaignSuccessful('SUCCESSFUL - FINALIZING')).toBe(true);
    });
    it('rejects in-flight and failed-terminal stages', () => {
      expect(isCampaignSuccessful('Fundraising')).toBe(false);
      expect(isCampaignSuccessful('Closed')).toBe(false);
      expect(isCampaignSuccessful('')).toBe(false);
    });
  });
});

const STORAGE_URL =
  'https://storage.googleapis.com/honeycomb-uploads/uploads/campaignMedia-1769609237409-875286201_tiny.png';

describe('extractHeroImageUrl', () => {
  it('prefers the canonical ogImageUrl when present', () => {
    const c = makeCampaign({
      ogImageUrl: STORAGE_URL,
      campaignMedia: [{ url: 'https://example.com/wrong.png' }],
    });
    expect(extractHeroImageUrl(c)).toBe(STORAGE_URL);
  });

  it('falls back to campaignMedia[].url when ogImageUrl is missing', () => {
    const c = makeCampaign({
      campaignMedia: [{ url: STORAGE_URL }],
    });
    expect(extractHeroImageUrl(c)).toBe(STORAGE_URL);
  });

  it('walks alternate keys inside campaignMedia items', () => {
    const c = makeCampaign({
      campaignMedia: [{ src: STORAGE_URL }],
    });
    expect(extractHeroImageUrl(c)).toBe(STORAGE_URL);
  });

  it('handles campaignMedia with a string entry', () => {
    const c = makeCampaign({
      campaignMedia: [STORAGE_URL],
    });
    expect(extractHeroImageUrl(c)).toBe(STORAGE_URL);
  });

  it('walks top-level alternates like heroImageUrl', () => {
    const c = makeCampaign({ heroImageUrl: STORAGE_URL });
    expect(extractHeroImageUrl(c)).toBe(STORAGE_URL);
  });

  it('deep-scans for a honeycomb-uploads URL when no known field has it', () => {
    // The-Saucy-African-style payload — image URL buried deep, no top-level field
    const c = makeCampaign({
      campaignStories: [
        { paragraphs: [{ media: { thumb: STORAGE_URL } }] },
      ],
    });
    expect(extractHeroImageUrl(c)).toBe(STORAGE_URL);
  });

  it('returns null when there is no image-shaped URL anywhere', () => {
    const c = makeCampaign({
      campaignMedia: [{ url: 'https://example.com/page' }],
    });
    expect(extractHeroImageUrl(c)).toBeNull();
  });

  it('does not false-positive on social-link strings', () => {
    const c = makeCampaign({
      issuer: { website: 'https://example.com', city: 'X', state: 'XX' },
      campaignMedia: [],
    });
    expect(extractHeroImageUrl(c)).toBeNull();
  });
});
