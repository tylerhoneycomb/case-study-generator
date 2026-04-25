import {
  RunReport,
  CampaignReport,
  CampaignFailure,
} from './types';
import { fetchListing, fetchCampaign, ScrapeError } from './scraper';
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
import {
  buildPromptInput,
  generateCaseStudy,
  GenerationError,
} from './generator';
import {
  uploadHeroImage,
  buildWixItem,
  insertCaseStudy,
  WixError,
} from './wix';
import {
  loadSmtpConfig,
  sendPerCampaignEmail,
  sendSummaryEmail,
} from './notifier';

const PUBLIC_BASE = 'https://honeycombcredit.com/case-studies/';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} required`);
  return v;
}

function wixCmsLink(siteId: string, itemId: string): string {
  return `https://manage.wix.com/dashboard/${siteId}/database/data/CaseStudies/${itemId}`;
}

function failureFor(slug: string, err: unknown): CampaignFailure {
  if (err instanceof ScrapeError) return { slug, stage: 'scrape', message: err.message };
  if (err instanceof GenerationError) return { slug, stage: 'generate', message: err.message };
  if (err instanceof WixError) {
    const stage =
      err.stage.startsWith('media') ? 'upload'
      : err.stage.startsWith('data') ? 'insert'
      : 'unknown';
    return { slug, stage: stage as CampaignFailure['stage'], message: err.message };
  }
  const e = err as Error;
  return { slug, stage: 'unknown', message: e.message ?? String(err) };
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
      let payload;
      try {
        payload = await fetchCampaign(slug);
      } catch (err) {
        report.failures.push(failureFor(slug, err));
        continue;
      }
      const stage = payload.campaignData.campaignStage;
      updateStage(tracked, slug, stage, todayISO);
      if (stage !== 'Funded') continue;

      // Step 3-6: generate, upload, insert, notify.
      try {
        const input = buildPromptInput(payload.campaignData, todayISO);
        const generated = await generateCaseStudy(input, anthropicKey);

        if (!payload.ogImageUrl) {
          throw new WixError('campaign missing ogImageUrl', 'media-fetch');
        }
        const heroMediaUrl = await uploadHeroImage(payload.ogImageUrl, wixAuth);

        const wixItem = buildWixItem(generated, payload.campaignData, todayISO, heroMediaUrl);
        const result = await insertCaseStudy(wixItem, wixAuth);

        const campaignReport: CampaignReport = {
          slug,
          businessName: wixItem.businessName,
          industry: wixItem.industry,
          niche: wixItem.niche,
          amountRaisedFormatted: wixItem.amountRaisedFormatted,
          investorCount: wixItem.investorCount,
          wixItemId: result._id,
          wixCmsUrl: wixCmsLink(wixAuth.siteId, result._id),
          publicPreviewUrl: PUBLIC_BASE + wixItem.slug,
          humanizationChecked: result.humanizationChecked,
          humanizationIssues: result.humanizationIssues,
        };
        report.processed.push(campaignReport);
        markProcessed(processed, slug);

        try {
          await sendPerCampaignEmail(campaignReport, smtp);
        } catch (err) {
          report.failures.push({ slug, stage: 'notify', message: (err as Error).message });
        }
      } catch (err) {
        report.failures.push(failureFor(slug, err));
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
