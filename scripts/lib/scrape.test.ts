import { describe, expect, it } from 'vitest';
import { isFunded, isFundraising, isCampaignSuccessful } from './scrape.js';

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
