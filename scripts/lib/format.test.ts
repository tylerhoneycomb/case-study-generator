import { describe, expect, it } from 'vitest';
import { formatMoney, formatPercent, formatTimeToFund, todayISO } from './format.js';

describe('formatMoney', () => {
  it('formats whole dollars', () => {
    expect(formatMoney(84000)).toBe('$84,000');
  });
  it('rounds non-integer cents', () => {
    expect(formatMoney(1234.56)).toBe('$1,235');
  });
  it('handles zero', () => {
    expect(formatMoney(0)).toBe('$0');
  });
});

describe('formatPercent', () => {
  it('rounds to whole percent', () => {
    expect(formatPercent(133.4)).toBe('133%');
    expect(formatPercent(133.7)).toBe('134%');
  });
});

describe('formatTimeToFund', () => {
  it('reports days under a week as "N day(s)"', () => {
    expect(formatTimeToFund('2026-04-01', '2026-04-04')).toBe('3 days');
    expect(formatTimeToFund('2026-04-01', '2026-04-02')).toBe('1 day');
  });
  it('reports a couple weeks as "N days"', () => {
    expect(formatTimeToFund('2026-04-01', '2026-04-20')).toBe('19 days');
  });
  it('reports ~30 days as "about a month"', () => {
    expect(formatTimeToFund('2026-04-01', '2026-05-01')).toBe('about a month');
  });
  it('reports several months as "N months"', () => {
    expect(formatTimeToFund('2026-04-01', '2026-07-01')).toBe('3 months');
  });
  it('returns "unknown" on bad input', () => {
    expect(formatTimeToFund('not a date', '2026-04-04')).toBe('unknown');
  });
});

describe('todayISO', () => {
  it('returns YYYY-MM-DD', () => {
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
