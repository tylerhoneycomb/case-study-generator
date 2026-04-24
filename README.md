# Honeycomb Collateral Development Agent

Daily cron agent that detects newly-Funded Honeycomb Credit campaigns, generates SEO-optimized case studies via the Claude API, and publishes drafts to the Honeycomb Credit website via the Wix `CaseStudies` CMS collection.

Target output location: `honeycombcredit.com/case-studies/{slug}`.

Authoritative spec: `docs/collateral_agent_spec_v3_3.md`.

## What this repo does

1. Scrapes `invest.honeycombcredit.com` daily, records every Fundraising slug in `data/tracked_campaigns.json`.
2. Re-checks every tracked slug that has not yet been processed. Campaigns now reading `Funded` are new case-study candidates.
3. For each new Funded campaign: calls Claude with `prompts/case-study-prompt.md`, uploads the hero image to Wix Media, POSTs a draft CMS item to Wix Data. The Wix `beforeInsert` hook then runs the humanization validator.
4. Emails a per-campaign notification to `NOTIFY_RECIPIENT` with the humanization verdict and a deep link to the Wix CMS entry.
5. Emails an end-of-run summary **every run, including zero-campaign days.** Silent failure is not a failure mode.
6. Commits the updated state files via `stefanzweifel/git-auto-commit-action@v5`.

## Required secrets

Set these in GitHub repo secrets (Settings → Secrets and variables → Actions):

| Name | Source |
|---|---|
| `ANTHROPIC_API_KEY` | https://console.anthropic.com/settings/keys |
| `WIX_API_KEY` | Wix dashboard → site settings → API keys (Phase 6 setup) |
| `WIX_SITE_ID` | `manage.wix.com/account/sites` URL when viewing the site dashboard |
| `SMTP_USER` | Outbound mailbox; defaults to `tyler@honeycombcredit.com` |
| `SMTP_PASS` | Google app password for `SMTP_USER` |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `NOTIFY_RECIPIENT` | `tyler@honeycombcredit.com` |

See `.env.example` for the full list. For local runs, copy to `.env` (git-ignored) and load with a tool of your choice (e.g. `node --env-file=.env dist/index.js`).

## Running locally

```bash
npm ci
npm run typecheck
npm run check-campaigns        # runs tsc then executes dist/index.js
```

## Running on GitHub Actions

Scheduled daily at 10 AM ET (`cron: '0 14 * * *'`). Manual trigger: Actions tab → "Daily Campaign Check" → Run workflow.

## Pre-flight before enabling cron

Follow the three pre-flight prompts in `docs/handoff.md`:

1. **Secrets**: verify all seven credentials exist and work.
2. **Seed state files**: the spec's pilot-seed strategy requires seeding `data/processed_campaigns.json` with every currently-Funded slug before the first run. Without this seed, day one will attempt to publish every Funded campaign the listing ever surfaces.
3. **Smoke test**: exercise Claude → Wix Media → Wix Data → dynamic-page gate end to end. Evidence goes in `~/honeycomb-agent-secrets/smoke-test-evidence/`.

## Where to look when it breaks

- **End-of-run summary email** is the health signal. If it stops arriving, the pipeline is broken.
- **GitHub Actions run logs** — Actions tab.
- **Wix CMS entries** — `CaseStudies` collection. Items with `humanizationChecked = false` render as 404; the reviewer edits the story to clear flags.
- **Scraper anomalies** — schema changes on Honeycomb's side surface in the summary email. Sample payloads for regression comparison live in `docs/sample_payloads/`.

## Source layout

```
src/index.ts        Orchestrator
src/scraper.ts      __NEXT_DATA__ fetch and parse
src/tracker.ts      tracked / processed state files
src/generator.ts    Claude API content generation
src/wix.ts          Wix Media + Wix Data
src/notifier.ts     per-campaign + summary email
src/types.ts        shared types

data/tracked_campaigns.json     every Fundraising slug seen
data/processed_campaigns.json   slugs already turned into drafts

prompts/case-study-prompt.md    runtime prompt sent to Claude
docs/                           spec, handoff, sample payloads
```

## Costs

Per spec § 12: under $1/month at steady state (~10 case studies/month). Claude API ~$0.05–$0.10 per case study; everything else free-tier.
