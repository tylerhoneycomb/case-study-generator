import nodemailer, { Transporter } from 'nodemailer';
import { CampaignReport, RunReport } from './types';

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  recipient: string;
}

export function loadSmtpConfig(): SmtpConfig {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT || '587');
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const recipient = process.env.NOTIFY_RECIPIENT;
  const missing: string[] = [];
  if (!user) missing.push('SMTP_USER');
  if (!pass) missing.push('SMTP_PASS');
  if (!recipient) missing.push('NOTIFY_RECIPIENT');
  if (missing.length > 0) {
    throw new Error(`Missing required env var(s): ${missing.join(', ')}`);
  }
  return { host, port, user: user!, pass: pass!, recipient: recipient! };
}

function buildTransport(cfg: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });
}

export async function sendPerCampaignEmail(
  report: CampaignReport,
  cfg: SmtpConfig,
): Promise<void> {
  const status = report.humanizationChecked
    ? 'PASSED humanization validator.'
    : 'FAILED humanization validator. The page will 404 until issues are resolved.';
  const issuesBlock = report.humanizationIssues
    ? `\nHumanization issues:\n${report.humanizationIssues}\n`
    : '';

  const body = [
    `New case study draft ready for review.`,
    ``,
    `Business: ${report.businessName}`,
    `Industry: ${report.industry}`,
    `Niche: ${report.niche}`,
    `Amount raised: ${report.amountRaisedFormatted}`,
    `Investors: ${report.investorCount}`,
    ``,
    `Wix CMS entry: ${report.wixCmsUrl}`,
    `Public preview (after status flip): ${report.publicPreviewUrl}`,
    ``,
    `Humanization: ${status}`,
    issuesBlock,
    `Action: open the CMS entry, resolve any humanization issues, preview, then flip status to "published".`,
  ].join('\n');

  await buildTransport(cfg).sendMail({
    from: cfg.user,
    to: cfg.recipient,
    subject: `New case study draft ready: ${report.businessName}`,
    text: body,
  });
}

export async function sendSummaryEmail(
  report: RunReport,
  cfg: SmtpConfig,
): Promise<void> {
  const date = report.runStartedISO.slice(0, 10);
  const lines: string[] = [];

  lines.push(`Collateral Agent run summary — ${date}`);
  lines.push(`Run started: ${report.runStartedISO}`);
  lines.push('');

  lines.push(`Tracked campaigns: ${report.trackedCount}`);
  lines.push(`Newly tracked this run: ${report.newlyTracked}`);
  lines.push(`Re-checked for transitions: ${report.rechecked}`);
  lines.push('');

  lines.push(`Processed (case studies drafted): ${report.processed.length}`);
  for (const p of report.processed) {
    const flag = p.humanizationChecked ? 'PASS' : 'FAIL';
    lines.push(
      `  - ${p.businessName} [${flag}] ${p.amountRaisedFormatted}, ${p.investorCount} investors`,
    );
    lines.push(`      ${p.wixCmsUrl}`);
    if (!p.humanizationChecked && p.humanizationIssues) {
      lines.push(`      Issues: ${p.humanizationIssues}`);
    }
  }
  lines.push('');

  const failed = report.processed.filter((p) => !p.humanizationChecked);
  lines.push(`Humanization failures: ${failed.length}`);
  for (const f of failed) lines.push(`  - ${f.slug}`);
  lines.push('');

  lines.push(`Errors: ${report.failures.length}`);
  for (const f of report.failures) {
    lines.push(`  - ${f.slug} [${f.stage}] ${f.message}`);
  }
  lines.push('');

  lines.push(`Scraper anomalies: ${report.scrapeAnomalies.length}`);
  for (const a of report.scrapeAnomalies) lines.push(`  - ${a}`);
  lines.push('');

  if (
    report.processed.length === 0 &&
    report.failures.length === 0 &&
    report.scrapeAnomalies.length === 0
  ) {
    lines.push('No new funded campaigns today. Pipeline healthy.');
  }

  await buildTransport(cfg).sendMail({
    from: cfg.user,
    to: cfg.recipient,
    subject: `Collateral Agent daily run — ${date}`,
    text: lines.join('\n'),
  });
}
