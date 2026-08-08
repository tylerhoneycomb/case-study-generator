# CLAUDE.md — funded.honeycombcredit.com

A GitHub Actions-driven autonomous publishing agent. The repo **is** the agent: a daily cron detects newly funded Honeycomb Credit campaigns, calls Claude to generate a case study, validates the copy for AI-writing tells, and commits the result as an MDX file. GitHub Pages serves the static site from those files.

---

## System purpose

Publish a case study page for every campaign that raises on [invest.honeycombcredit.com](https://invest.honeycombcredit.com). The site lives at [funded.honeycombcredit.com](https://funded.honeycombcredit.com).

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Astro 5 + TypeScript (strict, `noUncheckedIndexedAccess`) + Tailwind CSS 3.4 + MDX |
| Hosting | GitHub Pages (private repo, GitHub Pro) — custom domain via `public/CNAME` |
| CI/CD | GitHub Actions (four workflows) |
| AI generation | Anthropic SDK — `claude-opus-4-7` by default, overridable via `CASE_STUDY_MODEL` env var |
| Campaign discovery | PostHog HogQL — Fivetran-mirrored `postgres.campaigns` table |
| Campaign content | `__NEXT_DATA__` scrape of `invest.honeycombcredit.com` |
| Schema validation | Zod (three layers) |
| Testing | Vitest (57 tests) |

Node version: 20+ (`.nvmrc`).

---

## Directory layout

```
.github/
  workflows/
    deploy.yml          Astro build + GitHub Pages deploy (push to main / manual dispatch)
    detect.yml          Daily cron: funded-campaign discovery + case-study generation
    on-comment.yml      /funded slash-command dispatcher (issue/PR comments)
    on-issue.yml        Issue Form dispatcher ([Backfill] / [Redraft] title routing)
  ISSUE_TEMPLATE/
    backfill.yml        "Backfill case studies" Issue Form
    redraft-with-feedback.yml  "Redraft with feedback" Issue Form
    config.yml          Disables blank issues; surfaces the two forms

.state/
  detection-log.md      Daily cron heartbeat (one row per run, appended; committed)
  ratelimit.json        Today's generation counter (written per-run; not committed — known gap)

prompts/
  case-study-prompt.md  Runtime system prompt sent to Claude on every generation (~1000 lines)

public/
  og/                   Hero / OG images, one per case study (agent writes here)
  CNAME                 funded.honeycombcredit.com

scripts/
  generate.ts           Manual CLI: generate one case study by Honeycomb campaign slug
  redraft.ts            Regenerate an existing case study with reviewer feedback
  delete.ts             Remove a case study (MDX + hero image)
  detect.ts             Daily cron entry point: discovery → rate-limit → pipeline
  backfill.ts           Bulk historical generation from a newline-separated slug list
  inspect.ts            Diagnostic: scrape + schema-validate, no AI spend, no commits
  status.ts             Show today's rate-limit status
  cost-estimate.ts      Estimate API cost for a batch
  dispatch-comment.ts   on-comment.yml helper: parse /funded command + run pipeline
  dispatch-issue.ts     on-issue.yml helper: parse Issue Form body + route to CLI

  lib/
    pipeline.ts         Shared 6-stage per-slug pipeline (used by generate/redraft/backfill)
    claude.ts           Anthropic SDK wrapper: prompt load, API call, output validation
    humanize.ts         Regex-based AI-tells validator (circuit-breaker, not style guide)
    humanization-rules.ts  Shared ruleset (banned words, density caps) — drives both prompt + validator
    posthog.ts          HogQL client for funded-campaign discovery
    scrape.ts           invest.honeycombcredit.com __NEXT_DATA__ extractor
    image.ts            Hero image fetch + save to public/og/
    mdx.ts              MDX read/write; idempotency key is campaignSlug (not slug)
    github.ts           Octokit wrappers (createIssue, addComment, addLabel, etc.)
    ratelimit.ts        Per-day UTC budget: 1/day default, 10/day backfill cap, auto-reset at midnight UTC
    schemas.ts          Zod schemas: ClaudeOutputSchema, CampaignSchema, FrontmatterSchema
    format.ts           Numeric formatters ($1.2M, 47 investors, etc.)
    git.ts              Git wrapper (add, commit, push)
    log.ts              Structured logger
    args.ts             CLI argument parser
    parse-slugs.ts      Backfill input parser (defends against code-fence drift in Issue Form bodies)

src/
  content/
    case-studies/       One .mdx file per funded campaign (agent writes here)
    config.ts           Zod content schema — single source of truth for MDX frontmatter

  pages/
    index.astro         Homepage: grid of all case studies, sorted newest-first
    [...slug].astro     Dynamic case-study renderer (Astro file-based routing)
    admin/index.astro   Operator portal (noindex; PAT in localStorage; no backend)
    rss.xml.js          /rss.xml feed

  layouts/
    CaseStudy.astro     Main case-study template (hero → metrics → body → quote → CTA)

  components/
    BaseHead.astro      <head>: title, description, OG tags, canonical, Schema.org
    Hero.astro          H1, subhead, hero image, overlay metrics
    MetricsStrip.astro  $raised / goal / % / investors / time-to-fund cards
    Quote.astro         Optional founder quote block
    Cta.astro           Call-to-action button (links to pre-qualify URL)
    JsonLd.astro        Inlines Schema.org JSON-LD in <head>
    SiteHeader.astro    Site navigation
    SiteFooter.astro    Footer

  styles/
    global.css
```

---

## End-to-end data flow

### Daily automated flow

```
04:47 UTC (primary) / 11:23 UTC (backup) — detect.yml fires
  │
  ├─ PostHog HogQL query (postgres.campaigns, stage IN ('Funded','Successful - Finalizing'),
  │    campaignexpirationdate ≥ 2026-01-01, newest-first)
  │
  ├─ Filter: listAllCampaignSlugs() — already-published MDX files by campaignSlug
  │
  ├─ Rate-limit check: 1/day across all triggers (cron consumes first)
  │
  └─ Per-eligible campaign: open tracking issue → runPipeline(slug)
       │
       ├─ Stage 1: scrape invest.honeycombcredit.com (__NEXT_DATA__ + HTML fallbacks)
       ├─ Stage 2: call Claude (prompts/case-study-prompt.md + InputPayload JSON)
       ├─ Stage 3: humanization validation (retry once on fail; publish with warning label on final fail)
       ├─ Stage 4: fetch + store hero image to public/og/
       ├─ Stage 5: write MDX (YAML frontmatter + HTML body) to src/content/case-studies/
       └─ Stage 6: git add + commit

  After all pipelines: git push origin HEAD:main
  If pushed: gh workflow run deploy.yml --ref main

deploy.yml
  └─ npm ci → typecheck → test (57 vitest) → astro build → upload + deploy to GitHub Pages
       Live within ~2 min of any commit to main.
```

Two daily cron slots (`47 4 * * *` and `23 11 * * *`) exist because GitHub Actions silently delays or drops scheduled workflows during high-load periods. The script is idempotent — already-published campaigns are filtered before any rate-limit consumption — so running twice costs nothing when the first run lands cleanly.

### Manual / operator flow

All three entry points converge on the same audit log (Issues tab) and the same `scripts/` CLIs:

| Entry point | How it works |
|---|---|
| Operator portal at `/admin` | Browser form → opens tracking issue → posts `/funded <action> <slug>` as first comment → on-comment.yml picks it up |
| Slash command in any issue/PR comment | `/funded generate|redraft|delete|status|cost-estimate|inspect <slug>` — on-comment.yml routes to dispatch-comment.ts |
| Issue Forms | "Backfill case studies" or "Redraft with feedback" — on-issue.yml routes by `[Backfill]`/`[Redraft]` title prefix to dispatch-issue.ts |

---

## Content schema

`src/content/config.ts` is the single source of truth. Astro validates every MDX file against it at build time; a schema mismatch fails the build and blocks deploy.

### Frontmatter fields

| Field | Type | Notes |
|---|---|---|
| `businessName` | string | Displayed in headings and structured data |
| `niche` | string | Sub-type within industry (e.g. "sourdough bakery") |
| `industry` | enum (12 values) | Food & Beverage, Retail, Services, Health & Wellness, Agriculture, Manufacturing, Hospitality, Entertainment, Technology, Finance, Real Estate, Other |
| `city` | string | |
| `state` | string | Two-letter abbreviation |
| `h1Heading` | string | Page H1 (Claude writes this) |
| `heroSubhead` | string | Below H1 |
| `storyHeading` | string | H2 above the narrative body |
| `heroImage` | string | URL (fetched from campaign page, stored in public/og/) |
| `heroImageAlt` | string | |
| `ogImage` | string (optional) | Defaults to heroImage |
| `quote` | string (optional) | Founder quote |
| `quoteAttribution` | string (optional) | |
| `amountRaised` | string | Formatted (e.g. "$1.2M") |
| `goalAmount` | string | Formatted |
| `percentOfGoal` | string | Formatted (e.g. "143%") |
| `investorCount` | string | Formatted (e.g. "312 investors") |
| `timeToFund` | string | Formatted (e.g. "47 days") |
| `amountRaisedRaw` | number | Used by homepage sort/filter |
| `investorCountRaw` | number | |
| `timeToFundDays` | number | |
| `metaTitle` | string | |
| `metaDescription` | string | |
| `ogTitle` | string | |
| `ogDescription` | string | |
| `ctaText` | string | Button label |
| `campaignUrl` | string | Canonical invest.honeycombcredit.com URL |
| `campaignId` | string | Honeycomb internal ID |
| `campaignSlug` | string | Idempotency key; unique per Honeycomb campaign |
| `publishedDate` | date | ISO date string |
| `systemSchemaJson` | string | Serialized Schema.org JSON-LD (LocalBusiness subtype + Article) |

---

## Claude integration

**File:** `scripts/lib/claude.ts`

- Model: `claude-opus-4-7` (default). Override with `CASE_STUDY_MODEL` env var.
- System prompt: `prompts/case-study-prompt.md` (~1000 lines). `{{HUMANIZATION_*}}` placeholders are substituted from `humanization-rules.ts` at load time so the validator and prompt share one ruleset.
- Input: `InputPayload` JSON block (campaign name, slug, ID, city/state, metrics, ISO dates, HTML summary, use of proceeds, optional feedback for redrafts).
- Output: 14-key JSON object validated by `ClaudeOutputSchema` (Zod). Includes frontmatter fields + HTML body + Schema.org JSON-LD.
- Pricing (Opus 4.7): $15 input / $75 output per Mtok → ~$0.45 per generation.
- Max output tokens: 4096.

---

## Humanization validator

**File:** `scripts/lib/humanize.ts` + `scripts/lib/humanization-rules.ts`

Regex-based circuit-breaker that rejects AI-writing tells before the MDX is committed. Rules include: banned vocabulary (`leverage`, `innovative`, `seamless`, etc.), blocked openers (`In the heart of`, `In today's landscape`, etc.), hedge-phrase density caps, and em-dash / tricolon frequency limits.

Pipeline behavior:
1. After Claude's first response, run validator.
2. On failure: retry once, passing the violation list back to Claude as `redraftFeedback`.
3. On second failure: commit the MDX anyway, add `humanization-warning` label to the tracking issue.

---

## Rate limiting

**File:** `scripts/lib/ratelimit.ts`

- Default cap: **1 generation per UTC day** (shared across all triggers).
- Backfill override: up to **10/day** for a single `backfill.ts` run (`--rate=N` flag, capped at 10).
- Day boundary: UTC midnight; counter auto-resets.
- Ledger: `.state/ratelimit.json`. Written per run but **not currently committed** back to the repo (known gap — see below), so each workflow invocation starts with a fresh 0-of-1 budget.

---

## Zod validation layers

Three independent schema gates, each blocking a different failure mode:

| Schema | File | Validates | Failure mode |
|---|---|---|---|
| `FrontmatterSchema` | `src/content/config.ts` | MDX frontmatter at Astro build time | Build fails; deploy blocked |
| `ClaudeOutputSchema` | `scripts/lib/schemas.ts` | Claude's 14-key JSON response | Generation throws; tracking issue gets `error` label |
| `CampaignSchema` | `scripts/lib/schemas.ts` | Scraped campaign payload from invest.honeycombcredit.com | Scrape throws; tracking issue gets `error` label |

---

## Environment variables

### Required for generation scripts (`generate.ts`, `redraft.ts`, `backfill.ts`)

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key. In CI: repo secret. Locally: `.env`. |

### Required for detection cron (`detect.ts`)

| Variable | Description |
|---|---|
| `POSTHOG_API_KEY` | Personal PostHog API key with `project:query:read` scope. |
| `POSTHOG_PROJECT_ID` | Numeric PostHog project ID (Honeycomb Credit Production). |
| `POSTHOG_HOST` | Optional. PostHog cloud host. Defaults to `https://us.posthog.com`. |

### Required for GitHub operations (all scripts)

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | In CI: provided automatically. Locally: personal access token. |
| `GITHUB_REPOSITORY` | Repo in `owner/name` format. In CI: provided automatically. |

### Internal CI flag

| Variable | Description |
|---|---|
| `FUNDED_BOT_IDENTITY` | Set to `'1'` in all workflows. Scripts use this to skip interactive prompts. |
| `CASE_STUDY_MODEL` | Optional model override (e.g. `claude-sonnet-4-6` for cost testing). |

---

## GitHub Actions workflows

### `deploy.yml` — build + deploy

**Trigger:** push to `main`, or manual `workflow_dispatch`.

Steps: `npm ci` → `npm run typecheck` → `npm test` → `npm run build` → upload artifact → deploy to GitHub Pages.

Concurrency group `pages` (in-progress not cancelled — avoids partial deploys).

### `detect.yml` — daily cron

**Trigger:** cron `47 4 * * *` (04:47 UTC) and `23 11 * * *` (11:23 UTC), plus manual `workflow_dispatch` with optional `dry-run` input.

Steps: checkout → `npm ci` → `scripts/detect.ts` → `git push origin HEAD:main` → if pushed: `gh workflow run deploy.yml --ref main`.

Required secrets: `ANTHROPIC_API_KEY`, `POSTHOG_API_KEY`, `POSTHOG_PROJECT_ID`.

Permissions: `contents: write`, `issues: write`, `actions: write`.

### `on-comment.yml` — slash commands

**Trigger:** `issue_comment` created. Auth: `author_association` must be OWNER, COLLABORATOR, or MEMBER.

Comment body must start with `/funded `. Dispatches `scripts/dispatch-comment.ts`, pushes any commits, and triggers deploy.

### `on-issue.yml` — Issue Form dispatcher

**Trigger:** `issues` opened/edited/labeled. Routes by title prefix `[Backfill]` or `[Redraft]`. Anti-replay: adds `dispatched` label after first run.

Dispatches `scripts/dispatch-issue.ts`, pushes any commits, triggers deploy.

---

## Local development

```bash
nvm use                  # Node 20+ (reads .nvmrc)
npm install
cp .env.example .env     # fill in ANTHROPIC_API_KEY at minimum
npm run dev              # Astro dev server → http://localhost:4321
npm run build            # Static output to dist/
npm run typecheck        # astro sync && tsc --noEmit
npm test                 # vitest run (57 tests)
```

### Script reference

```bash
# Diagnostic — no AI spend, no commits
npx tsx scripts/inspect.ts <honeycomb-slug>

# Generate a single case study (~$0.45)
npx tsx scripts/generate.ts <honeycomb-slug> [--issue=N] [--force]

# Regenerate with reviewer feedback
npx tsx scripts/redraft.ts <case-study-slug> --feedback="..."

# Delete a case study
npx tsx scripts/delete.ts <case-study-slug>

# Bulk historical generation
npx tsx scripts/backfill.ts --slugs="slug-a\nslug-b\nslug-c" [--force] [--dry-run] [--rate=N]

# Daily cron entry point (discovery + pipeline)
npx tsx scripts/detect.ts [--dry-run]

# Rate-limit status
npx tsx scripts/status.ts

# Cost estimate
npx tsx scripts/cost-estimate.ts [--count=N]
```

**Note:** `generate.ts` and `backfill.ts` consume from the rate-limit ledger. Use `--dry-run` or `inspect.ts` when you only want to validate inputs.

---

## Tailwind brand tokens

```
honeycomb-yellow:  #FFDE17   (dominant; CTAs, highlights)
honeycomb-cream:   #F6F3E5   (page backgrounds)
honeycomb-purple:  #3F296B   (accents)
honeycomb-blue:    #D9ECFF
honeycomb-green:   #59B16B   (use sparingly)
honeycomb-ink:     #222222   (body text)
```

Fonts: Raleway (display/headlines), Open Sans (body + subheadings), both via `@fontsource`.

---

## TypeScript configuration

`tsconfig.json` extends `astro/tsconfigs/strict` and adds:

```json
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "noImplicitOverride": true,
  "target": "ES2022",
  "moduleResolution": "bundler"
}
```

---

## Astro configuration

`astro.config.mjs`:
- `site`: `https://funded.honeycombcredit.com`
- `trailingSlash`: `never`
- `build.format`: `directory`
- Integrations: `@astrojs/mdx`, `@astrojs/sitemap` (excludes `/admin`), `@astrojs/tailwind`

---

## Known gaps

1. **Founder-level input data.** The pipeline payload contains campaign summary, use-of-proceeds, and metrics — but no founder name, photo, or verbatim Q&A. The "Ask The Founders" tab on each campaign page is the single biggest quality lever still on the roadmap. See `prompts/case-study-prompt.md §6` for current compensating prompt instructions.

2. **Rate-limit persistence is per-run, not per-day.** `consume()` writes `.state/ratelimit.json` but workflows do not commit it back to the repo. Each workflow invocation starts fresh at 0-of-1. In practice this has not caused over-spend (cron runs once/day; backfill self-caps; manual ops are rare), but the "1/day across all triggers" semantic is softer than documented. Fix: add `.state/ratelimit.json` to the `git add` list in `pipeline.ts`.

3. **Pre-2026 historical campaigns are not auto-published.** The PostHog query floors at `campaignexpirationdate >= '2026-01-01'`. ~570 historical funded campaigns are visible to PostHog but intentionally skipped by the cron. Use the "Backfill case studies" Issue Form to hand-pick any you want published.
