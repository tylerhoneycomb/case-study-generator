# CLAUDE.md — Collateral Development Agent

This file is the primary context document for AI coding tools working in this repo. Read it before touching any code.

## What this project is

A fully-automated case study publishing system for [funded.honeycombcredit.com](https://funded.honeycombcredit.com). Every funded Honeycomb Credit campaign gets a public case study — scraped from `invest.honeycombcredit.com`, written by Claude Opus 4.7, validated for AI-writing tells, committed as an MDX file, and deployed as a static Astro site on GitHub Pages.

**The repository itself is the agent.** There is no backend server. GitHub Actions is the compute layer; git + GitHub Issues is the state and audit layer.

---

## Architecture in one paragraph

`detect.yml` runs (when active) on a daily schedule, calling `scripts/detect.ts`, which queries PostHog (Fivetran-mirrored `postgres.campaigns`) for funded campaigns not yet published. For each eligible slug it calls `scripts/lib/pipeline.ts`, which: (1) scrapes the campaign from `invest.honeycombcredit.com` via `__NEXT_DATA__`, (2) calls `scripts/lib/claude.ts` (Anthropic SDK, `claude-opus-4-7`, prompt at `prompts/case-study-prompt.md`), (3) validates Claude's output with `scripts/lib/humanize.ts` (retries once on fail; publishes on second fail with `humanization-warning` label), (4) fetches the hero image to `public/og/`, (5) writes the MDX file to `src/content/case-studies/`, (6) commits via `scripts/lib/git.ts`. The same pipeline is triggered manually via the operator portal (`/admin`), `/funded` slash commands in Issue comments, or Issue Form submissions. Every trigger opens a GitHub tracking issue and posts progress there. After any commit, `deploy.yml` rebuilds the Astro site and deploys to GitHub Pages.

---

## Development commands

```bash
nvm use                # Node 20 (see .nvmrc)
npm install
npm run dev            # Astro dev server at http://localhost:4321
npm run build          # Static build to dist/
npm run typecheck      # astro sync && tsc --noEmit (must pass before deploy)
npm test               # vitest run — 65 tests across 5 files
```

Local agent CLI (requires `.env` with `ANTHROPIC_API_KEY` and `GITHUB_TOKEN`):

```bash
npx tsx scripts/inspect.ts <slug>              # diagnostic only, no spend
npx tsx scripts/generate.ts <slug>             # ~$0.45 spend
npx tsx scripts/redraft.ts <slug> [--feedback="..."]
npx tsx scripts/delete.ts <slug>
npx tsx scripts/backfill.ts --slugs="A\nB\nC" [--force] [--dry-run] [--rate=N]
npx tsx scripts/detect.ts [--dry-run]          # cron entry point
npx tsx scripts/status.ts <slug>
npx tsx scripts/cost-estimate.ts
```

---

## Repository layout

```
src/
  content/
    case-studies/        ← one .mdx per campaign (28 published as of 2026-06)
    config.ts            ← Zod schema for MDX frontmatter (build-time validation)
  pages/
    [...slug].astro      ← case-study renderer (getStaticPaths)
    index.astro          ← case study directory listing
    admin/index.astro    ← operator portal (static, noindex, GitHub API via PAT)
    rss.xml.js           ← /rss.xml
  layouts/
    CaseStudy.astro      ← hero + 3-tile MetricsStrip + body + CTA + JSON-LD
  components/            ← Hero, MetricsStrip, Quote, Cta, JsonLd, BaseHead, SiteHeader, SiteFooter

scripts/
  generate.ts            ← end-to-end single-slug generation
  redraft.ts             ← regenerate with optional feedback string
  delete.ts              ← remove MDX + hero image
  backfill.ts            ← batch generate from slug list
  detect.ts              ← daily cron entry point (PostHog → pipeline)
  inspect.ts             ← diagnostic, no spend, no commits
  status.ts              ← check publication status
  cost-estimate.ts       ← estimate generation cost
  dispatch-comment.ts    ← parse /funded slash commands from issue comments
  dispatch-issue.ts      ← parse Issue Form submissions
  lib/
    pipeline.ts          ← shared per-slug pipeline (all entry points call this)
    schemas.ts           ← Zod: ClaudeOutputSchema, CampaignSchema, ListingEntrySchema
    claude.ts            ← Anthropic SDK wrapper, output validation, pricing
    humanize.ts          ← AI-tells regex validator; retry / publish-with-warning policy
    humanization-rules.ts← SINGLE SOURCE OF TRUTH for banned vocab/phrases/openers
    posthog.ts           ← HogQL client for funded-campaign discovery
    scrape.ts            ← __NEXT_DATA__ + HTML extraction from invest.honeycombcredit.com
    mdx.ts               ← MDX read/write; findByCampaignSlug() for idempotency
    github.ts            ← Octokit wrappers (createIssue, addComment, addLabel)
    ratelimit.ts         ← 1/day default cap; 10/day backfill override; UTC reset
    image.ts             ← fetch + store hero images to public/og/
    git.ts               ← git add/commit wrappers
    format.ts            ← money/date formatters
    log.ts               ← stdout + GitHub Issues logging
    args.ts              ← CLI argument parser
    parse-slugs.ts       ← backfill input parser (defends against code-fence drift)
    *.test.ts            ← Vitest unit tests (65 total across 5 files)

.github/
  workflows/
    detect.yml           ← daily cron (PAUSED as of 2026-06-09); workflow_dispatch active
    deploy.yml           ← Astro build + GitHub Pages deploy on push to main
    on-comment.yml       ← /funded slash dispatcher
    on-issue.yml         ← Issue Form dispatcher (Backfill / Redraft)
  ISSUE_TEMPLATE/
    backfill.yml         ← batch generate form
    redraft-with-feedback.yml
    config.yml

prompts/
  case-study-prompt.md   ← runtime prompt sent to Claude on every generation (~1000 lines)

.state/
  detection-log.md       ← daily cron heartbeat (one row per run, appended)
  ratelimit.json         ← today's generation counter (written in CI, NOT committed back)

public/
  og/                    ← hero/OG images, one .png per case study
  CNAME                  ← funded.honeycombcredit.com
```

---

## Three validation layers (Zod schemas)

| File | What it validates | Failure mode |
|---|---|---|
| `src/content/config.ts` | MDX frontmatter at Astro build time | Build fails; deploy never ships |
| `scripts/lib/schemas.ts` → `ClaudeOutputSchema` | Claude's 14-key JSON response | Generation fails; issue gets `error` label |
| `scripts/lib/schemas.ts` → `CampaignSchema` | Scraped campaign payload shape | Scrape fails; issue gets `error` label |

These three schemas must stay in sync when frontmatter fields change. `INDUSTRIES` is defined in both `src/content/config.ts` and `scripts/lib/schemas.ts` — update both.

---

## Claude output contract (14 keys)

Claude must return a JSON object with exactly these top-level keys:

| Key | Type | Notes |
|---|---|---|
| `h1Heading` | string | 6–14 words; tension/claim/unique angle; no dollar figures |
| `heroSubhead` | string | 8–16 words; adds a new beat (not a summary of h1) |
| `storyHeading` | string | 4–10 words; specific to this business |
| `story` | HTML string | 800–1200 words; only allowed HTML tags (see prompt §11) |
| `heroImageAlt` | string | 8–16 words; describes the photo, not the business |
| `metaTitle` | string | ≤60 chars |
| `metaDescription` | string | 120–160 chars |
| `ogTitle` | string | ≤60 chars |
| `ogDescription` | string | 120–160 chars |
| `ctaText` | string | Call-to-action button label |
| `slug` | string | 3–6 word lowercase hyphenated; must not reuse the platform slug |
| `niche` | string | Free-form descriptor (e.g. "bone broth shop") |
| `industry` | string | One of 12 controlled values (see `src/content/config.ts`) |
| `systemSchemaJson` | string | JSON-LD string; two entities (LocalBusiness + Article) |

The pipeline adds these fields itself (not Claude outputs): `businessName`, `city`, `state`, `heroImage`, `ogImage`, `amountRaised`, `amountRaisedFormatted`, `investorCount`, `timeToFund`, `campaignUrl`, `campaignId`, `campaignSlug`, `publishedDate`.

---

## MetricsStrip tiles (3 tiles)

The `MetricsStrip.astro` component renders three tiles: **Raised**, **Investors**, **Time to fund**. The "Of goal" tile was removed on 2026-06-09 (`83493d6`). The four backing frontmatter fields (`goalAmount`, `goalAmountFormatted`, `percentOfGoal`, `percentOfGoalFormatted`) were also removed from `src/content/config.ts` and the pipeline. Do not add them back. Partial-funded outcomes are addressed in the narrative (prompt §6 Beat 4) rather than the visual KPI strip.

---

## Humanization validation

`scripts/lib/humanization-rules.ts` is the single source of truth for banned vocabulary, banned hedge phrases, not-just-but pivot patterns, and banned openers. Both the runtime prompt (`claude.ts` injects these via `applyPromptSubstitutions()`) and the validator (`humanize.ts`) read from this file — adding a banned word updates both automatically.

**Retry policy:** validator runs after every Claude call. On first failure, Claude receives targeted feedback listing the flagged patterns. On second failure, the case study is published anyway with a `humanization-warning` label on the tracking issue (a hard gate would leave funded campaigns unpublished).

---

## Idempotency

`generate.ts` skips generation if a case study already exists for the campaign. The lookup is by `campaignSlug` frontmatter field (`scripts/lib/mdx.ts` → `findByCampaignSlug()`), not by filename — Claude's chosen output slug can vary between runs. Pass `--force` to override.

---

## Rate limiting

Default cap: **1 generation per day** across all triggers (cron + manual + portal). Backfill overrides up to **10/day** with `--rate=N`. State lives in `.state/ratelimit.json` (UTC reset). **Known gap:** workflows do not commit this file back, so each new workflow invocation starts fresh. In practice this hasn't caused overspend but the semantic is more permissive than the documented 1/day.

---

## GitHub Actions workflows

| Workflow | Trigger | State |
|---|---|---|
| `detect.yml` | `workflow_dispatch` (schedule PAUSED since 2026-06-09) | Paused — resume by uncommenting `schedule:` block |
| `deploy.yml` | Push to `main`, `workflow_dispatch` | Active |
| `on-comment.yml` | Issue comment matching `/funded` | Active |
| `on-issue.yml` | Issues opened/edited/labeled | Active |

Pushes from CI workflows don't auto-trigger `deploy.yml` (GitHub recursion guard). The agent explicitly dispatches `deploy.yml` via `gh workflow run deploy.yml --ref main` after pushing content.

---

## Environment variables

| Variable | Where | Required for |
|---|---|---|
| `ANTHROPIC_API_KEY` | `.env` locally; repo secret in CI | generate, redraft, backfill |
| `GITHUB_TOKEN` | auto in CI; `.env` locally | issue tracking, comments |
| `POSTHOG_API_KEY` | repo secret | detect.yml (PostHog HogQL queries) |
| `POSTHOG_PROJECT_ID` | repo secret | detect.yml |
| `CASE_STUDY_MODEL` | optional env var | override Claude model (default: `claude-opus-4-7`) |
| `POSTHOG_HOST` | optional env var | override PostHog host (default: `us.posthog.com`) |
| `FUNDED_BOT_IDENTITY` | set to `'1'` in CI workflows | identity flag for log routing |

---

## Key design invariants

1. **No backend server.** All compute is GitHub Actions. All state is git + GitHub Issues.
2. **All three input surfaces (cron, portal, slash commands) call the same `pipeline.ts`.** Don't add a separate code path.
3. **Validation schemas are the contracts.** `src/content/config.ts`, `ClaudeOutputSchema`, and `CampaignSchema` must stay in sync. Build failures are the safety net for schema drift.
4. **Slugs are owned by Claude, not the platform.** The output slug is distinct from `campaignSlug` (the platform's URL segment). `campaignSlug` is stored in frontmatter and is the idempotency key. The output slug becomes the MDX filename and the public URL.
5. **Every concrete claim traces to the input payload.** The prompt's grounding rule (§13) prohibits hedge-filler sentences about missing data. If data is thin, the story is shorter — not padded.
6. **`humanization-rules.ts` is updated first.** When adding a banned word or phrase, edit `humanization-rules.ts` — the change propagates to both the validator and the next prompt call automatically.

---

## Current operational state (as of 2026-06-23)

- **28 case studies published** in `src/content/case-studies/`
- **Daily cron paused** (2026-06-09) — `workflow_dispatch` still works
- **65 Vitest tests** across `format`, `humanize`, `parse-slugs`, `posthog`, `scrape`
- **Model:** `claude-opus-4-7` (~$0.45/generation at ~17K input + ~2.7K output tokens)
- **Site live at:** https://funded.honeycombcredit.com
- **Operator portal:** https://funded.honeycombcredit.com/admin
