import {
  RunReport,
  CampaignFailure,
} from './types';
import { fetchListing, fetchCampaign } from './scraper';
import {
  loadTracked,
  saveTracked,
  loadProcessed,
  saveProcessed,
  markSeenFundraising,
  updateStage,
  candidatesForTransitionCheck,
  markProcessed,
} from './tracker';
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
    const anthropicKey = requireEnv('ANTHROPIC_API_KEY');
    const wixAuth = {
      apiKey: requireEnv('WIX_API_KEY'),
      siteId: requireEnv('WIX_SITE_ID'),
    };
    const deps = { anthropicKey, wixAuth, todayISO };

    const tracked = await loadTracked();
    const processed = await loadProcessed();

    // Step 1: refresh tracked from listing.
    try {
      const listing = await fetchListing();
      for (const entry of listing) {
        if (entry.campaignStage === 'Fundraising') {
          if (markSeenFundraising(tracked, entry.slug, todayISO)) {
            report.newlyTracked++;
          }
        } else {
          updateStage(tracked, entry.slug, entry.campaignStage, todayISO);
        }
      }
      tracked.lastSyncISO = todayISO;
    } catch (err) {
      report.scrapeAnomalies.push(
        `listing fetch failed: ${(err as Error).message}`,
      );
    }

    // Step 2: re-check non-Funded, unprocessed slugs for transitions.
    const candidates = candidatesForTransitionCheck(tracked, processed);
    report.rechecked = candidates.length;

    for (const slug of candidates) {
      let stage: string;
      try {
        const payload = await fetchCampaign(slug);
        stage = payload.campaignData.campaignStage;
        updateStage(tracked, slug, stage, todayISO);
      } catch (err) {
        const f = classifyError(err);
        report.failures.push({ slug, ...f } as CampaignFailure);
        continue;
      }
      if (stage !== 'Funded') continue;

      // Funded: run the create pipeline.
      try {
        const outcome = await processSlugCreate(slug, deps);
        if (!outcome.ok) {
          report.failures.push({
            slug,
            stage: 'insert',
            message: outcome.message,
          });
          continue;
        }
        report.processed.push(outcome.report);
        markProcessed(processed, slug);
        try {
          await sendPerCampaignEmail(outcome.report, smtp, 'create');
        } catch (err) {
          report.failures.push({ slug, stage: 'notify', message: (err as Error).message });
        }
      } catch (err) {
        const f = classifyError(err);
        report.failures.push({ slug, ...f } as CampaignFailure);
      }
    }

    report.trackedCount = Object.keys(tracked.campaigns).length;
    await saveTracked(tracked);
    await saveProcessed(processed);
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
