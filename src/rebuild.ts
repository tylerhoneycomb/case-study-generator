import { CampaignFailure, RunReport } from './types';
import { processSlugRebuild, classifyError } from './pipeline';
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

function parseSlugs(input: string | undefined): string[] {
  if (!input) return [];
  return input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
    const slugs = parseSlugs(process.env.SLUGS);
    if (slugs.length === 0) {
      throw new Error('SLUGS env var (comma-separated) required');
    }

    const anthropicKey = requireEnv('ANTHROPIC_API_KEY');
    const wixAuth = {
      apiKey: requireEnv('WIX_API_KEY'),
      siteId: requireEnv('WIX_SITE_ID'),
    };
    const deps = { anthropicKey, wixAuth, todayISO };

    report.rechecked = slugs.length;
    console.log(`Rebuilding ${slugs.length} case study(s):`, slugs.join(', '));

    for (const slug of slugs) {
      try {
        const outcome = await processSlugRebuild(slug, deps);
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
          await sendPerCampaignEmail(outcome.report, smtp, 'rebuild');
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
