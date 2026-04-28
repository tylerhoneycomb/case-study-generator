// Display formatters used by the agent to populate the *Formatted fields the
// content schema expects. Keeping them in one place so the runtime prompt
// and the rendered pages can't drift on whether $1,000.00 or $1,000 is the
// canonical form.

const moneyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

export function formatMoney(amount: number): string {
  return moneyFmt.format(Math.round(amount));
}

export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

// Compute time-to-fund from the campaign start/expiration. Honeycomb
// surfaces the date the campaign hit its goal indirectly — we approximate
// using the duration between launch and expiration for now. Reviewer can
// edit the MDX if the actual close-date is available.
export function formatTimeToFund(startISO: string, endISO: string): string {
  const start = new Date(startISO);
  const end = new Date(endISO);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return 'unknown';
  }
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));
  if (days < 7) return `${days} day${days === 1 ? '' : 's'}`;
  if (days < 30) return `${days} days`;
  if (days < 60) return `about a month`;
  const months = Math.round(days / 30);
  return `${months} months`;
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
