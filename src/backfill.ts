import { CampaignFailure, RunReport } from './types';
import { fetchCampaign } from './scraper';
import { loadProcessed } from './tracker';
import { processSlugCreate, classifyError } from './pipeline';
import {
  loadSmtpConfig,
  sendPerCampaignEmail,
  sendSummaryEmail,
} from './notifier';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} required`);
  return v;
}

function parseList(input: string | undefined): string[] {
  if (!input) return [];
  return input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isISODate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

async function resolveSlugsByName(
  query: string,
  seedSlugs: string[],
): Promise<string[]> {
  const lower = query.toLowerCase();
  return seedSlugs.filter((slug) => slug.toLowerCase().includes(lower));
}

interface DateRange {
  from?: string;
  to?: string;
}

async function resolveSlugsByDateRange(
  range: DateRange,
  seedSlugs: string[],
): Promise<{ matched: string[]; anomalies: string[] }> {
  const matched: string[] = [];
  const anomalies: string[] = [];
  console.log(
    `Date-range filter: scraping ${seedSlugs.length} seed slugs to read campaignExpirationDate (this is slow).`,
  );
  for (const slug of seedSlugs) {
    try {
      const payload = await fetchCampaign(slug);
      const expiration = payload.campaignData.campaignExpirationDate;
      if (!expiration || !isISODate(expiration.slice(0, 10))) {
        anomalies.push(`${slug}: missing/invalid campaignExpirationDate`);
        continue;
      }
      const exp = expiration.slice(0, 10);
      if (range.from && exp < range.from) continue;
      if (range.to && exp > range.to) continue;
      matched.push(slug);
    } catch (err) {
      anomalies.push(`${slug}: scrape failed (${(err as Error).message})`);
    }
  }
  return { matched, anomalies };
}

async function main(): Promise<number> {
  const todayISO = new Date().toISOString();
  const report: RunReport = {
    runStartedISO: todayISO,
    processed: [],
    failures: [],
    scrapeAnomalies: [],
    trackedCount: 0,
    rechecked: 0,
    newlyTracked: 0,
  };

  const smtp = loadSmtpConfig();
  let exitCode = 0;

  try {
    const slugInput = parseList(process.env.SLUGS);
    const nameQueries = parseList(process.env.BUSINESS_NAMES);
    const fromDate = process.env.FROM_DATE?.trim();
    const toDate = process.env.TO_DATE?.trim();

    const hasSlugs = slugInput.length > 0;
    const hasNames = nameQueries.length > 0;
    const hasDates = Boolean(fromDate || toDate);

    if (!hasSlugs && !hasNames && !hasDates) {
      throw new Error('At least one of SLUGS, BUSINESS_NAMES, or FROM_DATE/TO_DATE required');
    }
    if (fromDate && !isISODate(fromDate)) {
      throw new Error(`FROM_DATE must be YYYY-MM-DD, got ${fromDate}`);
    }
    if (toDate && !isISODate(toDate)) {
      throw new Error(`TO_DATE must be YYYY-MM-DD, got ${toDate}`);
    }

    const anthropicKey = requireEnv('ANTHROPIC_API_KEY');
    const wixAuth = {
      apiKey: requireEnv('WIX_API_KEY'),
      siteId: requireEnv('WIX_SITE_ID'),
    };
    const deps = { anthropicKey, wixAuth, todayISO };

    const processed = await loadProcessed();
    const seedSlugs = processed.slugs;

    const candidateSet = new Set<string>();

    if (hasSlugs) {
      for (const s of slugInput) candidateSet.add(s);
      console.log(`Direct slugs: ${slugInput.length} added.`);
    }

    if (hasNames) {
      for (const q of nameQueries) {
        const matches = await resolveSlugsByName(q, seedSlugs);
        console.log(`Business name "${q}" matched ${matches.length} slug(s):`, matches.join(', '));
        for (const m of matches) candidateSet.add(m);
      }
    }

    if (hasDates) {
      const { matched, anomalies } = await resolveSlugsByDateRange(
        { from: fromDate, to: toDate },
        seedSlugs,
      );
      console.log(
        `Date range ${fromDate ?? '*'}..${toDate ?? '*'} matched ${matched.length} slug(s).`,
      );
      report.scrapeAnomalies.push(...anomalies);
      for (const m of matched) candidateSet.add(m);
    }

    const candidates = [...candidateSet].sort();
    report.rechecked = candidates.length;
    console.log(`Total candidates to backfill: ${candidates.length}`);

    if (candidates.length === 0) {
      console.warn('No candidates resolved. Nothing to do.');
    }

    for (const slug of candidates) {
      try {
        const outcome = await processSlugCreate(slug, deps);
        if (!outcome.ok) {
          report.failures.push({
            slug,
            stage: 'insert',
            message: outcome.message,
          });
          console.warn(`SKIP ${slug}: ${outcome.message}`);
          continue;
        }
        report.processed.push(outcome.report);
        try {
          await sendPerCampaignEmail(outcome.report, smtp, 'backfill');
        } catch (err) {
          report.failures.push({ slug, stage: 'notify', message: (err as Error).message });
        }
        console.log(`OK ${slug}: ${outcome.report.wixCmsUrl}`);
      } catch (err) {
        const f = classifyError(err);
        report.failures.push({ slug, ...f } as CampaignFailure);
        console.error(`FAIL ${slug}: ${f.message}`);
      }
    }
  } catch (err) {
    exitCode = 1;
    report.failures.push({
      slug: '(run)',
      stage: 'unknown',
      message: (err as Error).message ?? String(err),
    });
  } finally {
    try {
      await sendSummaryEmail(report, smtp);
    } catch (err) {
      console.error('summary email failed:', (err as Error).message);
      exitCode = exitCode || 1;
    }
  }

  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('fatal:', err);
    process.exit(1);
  },
);
