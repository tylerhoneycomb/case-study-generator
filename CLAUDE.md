# CLAUDE.md — Engineering Reference

> This file is the single-document engineering reference for this repo. It is
> intended to be self-sufficient: an AI coding tool (or new engineer) reading
> only this file should be able to understand the system, reproduce it, and
> make changes safely.

---

## What this project does

**funded.honeycombcredit.com** is the Collateral Development Agent — a static
site that auto-publishes a marketing case study for every campaign that
successfully closes on the Honeycomb Credit investment platform. The repo IS
the agent: GitHub Actions handles scheduling and event routing; operators
drive ad-hoc actions through GitHub Issues and a web portal; case studies
live as MDX files committed directly to this repo.

The live site is at https://funded.honeycombcredit.com.

---

## Architecture overview

```
PostHog (Fivetran mirror of postgres.campaigns)
    │
    ▼  daily 12:07 UTC cron (detect.yml)
scripts/detect.ts
    │  queries funded slugs (≥ 2026-01-01, newest first)
    │  filters against already-published MDX files
    │  rate-limits to 3/day
    │
    ▼  per-slug pipeline (scripts/lib/pipeline.ts)
  1. scrape invest.honeycombcredit.com/__NEXT_DATA__
  2. call Claude Opus 4.7 → validate JSON output (Zod)
  3. humanization validator (hard gate — blocks if AI-tells found)
  4. fetch + store hero image → public/og/{slug}.{ext}
  5. write MDX → src/content/case-studies/{slug}.mdx
  6. git add + commit

    │
    ▼  push to main
GitHub Pages deploy (deploy.yml)
    │  astro sync && tsc --noEmit + vitest run (65 tests) + astro build
    │
    ▼
https://funded.honeycombcredit.com (live within ~2 min)
```

The same pipeline is also reachable via:
- **Operator portal** at `/admin` — form-based UI, PAT auth, no backend
- **Slash commands** — `/funded generate|redraft|delete|status|cost-estimate|inspect <slug>` in any issue/PR comment by a repo collaborator
- **Issue Forms** — "Backfill case studies" and "Redraft with feedback" for high-input operations

---

## Tech stack

| Layer | Technology |
|---|---|
| Site framework | Astro 5, TypeScript (strict, `noUncheckedIndexedAccess`), Tailwind, MDX content collections |
| Hosting | GitHub Pages from private repo (GitHub Pro) |
| CI/CD | GitHub Actions (4 workflows: deploy, detect, on-comment, on-issue) |
| AI generation | Anthropic SDK, Claude Opus 4.7 (`claude-opus-4-7`) |
| Data discovery | PostHog HogQL query against Fivetran-mirrored `postgres.campaigns` |
| Schema validation | Zod (3 distinct contracts — see Contracts section) |
| Testing | Vitest, 65 tests across 5 test files |
| Runtime | Node ≥ 20 (see `.nvmrc`); scripts run with `tsx` |

---

## Environment variables

| Variable | Where required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | `generate`, `redraft`, `backfill` | Repo secret in CI |
| `GITHUB_TOKEN` | All issue/comment ops | Auto-set in CI via `secrets.GITHUB_TOKEN` |
| `GITHUB_REPOSITORY` | `github.ts` (Octokit) | Auto-set in CI; set `FUNDED_REPO=owner/repo` locally |
| `POSTHOG_API_KEY` | `detect` | Personal API key with `project:query:read`; add as repo secret |
| `POSTHOG_PROJECT_ID` | `detect` | Numeric PostHog project ID; add as repo secret |
| `POSTHOG_HOST` | `detect` | Optional; defaults to `https://us.posthog.com` |
| `CASE_STUDY_MODEL` | `claude.ts` | Optional override; defaults to `claude-opus-4-7` |
| `FUNDED_BOT_IDENTITY` | `git.ts` | Set to `1` in CI workflows to configure bot git identity |

Copy `.env.example` and fill in values for local development.

---

## Key contracts (Zod schemas)

Three independent Zod schemas gate three different boundaries:

### 1. `src/content/config.ts` — MDX frontmatter (Astro build-time)

Validates every `.mdx` file under `src/content/case-studies/`. A malformed
file fails the Astro build and never reaches production. Key fields:

- **Identity**: `businessName`, `niche`, `industry` (enum), `city`, `state` (2-char uppercase)
- **Headings**: `h1Heading`, `heroSubhead`, `storyHeading`
- **Image**: `heroImage` (path `/og/{slug}.{ext}`), `heroImageAlt`, optional `ogImage`
- **Metrics**: `amountRaised` (int), `goalAmount` (int), `percentOfGoal`, `investorCount`, `timeToFund`
- **SEO**: `metaTitle` (40–70), `metaDescription` (120–180), `ogTitle` (30–80), `ogDescription` (60–160)
- **CTA**: `ctaText` (no `ctaUrl` — Cta.astro builds the UTM-tagged href from `campaignSlug`)
- **Traceability**: `campaignUrl`, `campaignId`, `campaignSlug`, `publishedDate`
- **JSON-LD**: `systemSchemaJson` (array of typed objects, or single typed object)

### 2. `scripts/lib/schemas.ts` `ClaudeOutputSchema` — Claude's JSON response

Validates the 14 keys Claude must return. Generation fails fast (tracking
issue gets `error` label) if any key is missing or malformed. Key fields:
`h1Heading`, `heroSubhead`, `storyHeading`, `story` (≥2000 chars rich-text HTML),
`heroImageAlt`, `metaTitle`, `metaDescription`, `ogTitle`, `ogDescription`,
`ctaText`, `slug` (lowercase kebab-case regex), `niche`, `industry` (enum),
`systemSchemaJson`.

### 3. `scripts/lib/schemas.ts` `CampaignSchema` — Honeycomb scrape payload

Validates the `__NEXT_DATA__` blob from `invest.honeycombcredit.com/campaigns/{slug}`.
Defensive: only identity fields (`slug`, `campaignName`, `campaignId`, `campaignStage`)
are required; everything else is optional. When Honeycomb's Next.js app shape
changes, this schema catches it.

### INDUSTRIES enum (controlled vocabulary)

Defined in both `src/content/config.ts` and `scripts/lib/schemas.ts` (duplicate
is intentional — keeps scripts independent of the Astro build runtime):

```
Food & Beverage | Retail | Health & Wellness | Personal Services |
Professional Services | Arts & Entertainment | Manufacturing & Craft |
Agriculture | Hospitality | Technology | Education | Other
```

Additive only — never rename an existing value (orphans prior case studies).

---

## Per-slug pipeline stages (`scripts/lib/pipeline.ts`)

```
RunOptions { slug, feedback?, skipFundedCheck?, forcedOutputSlug? }
    │
    1. fetchCampaign(slug)           → scrape.ts → CampaignSchema validation
    │  Pre-check: isCampaignSuccessful(stage) unless skipFundedCheck
    │  Pre-check: city, state, target, summary must all be non-empty
    │
    2. generateCaseStudy(payload)    → claude.ts → ClaudeOutputSchema validation
    │  Prompt: prompts/case-study-prompt.md ({{HUMANIZATION_*}} placeholders
    │  substituted at load time from humanization-rules.ts)
    │
    3. validateCopy(stripHtml(story)) → humanize.ts → HARD GATE
    │  Any flag → PipelineError('humanize') → tracking issue gets 'error' label
    │
    4. extractHeroImageUrl(campaign, pageProps, html)  → 6-priority fallback chain
    │  fetchAndStoreHeroImage({ ogImageUrl, slug }) → public/og/{slug}.{ext}
    │
    5. writeCaseStudy({ slug, frontmatter, body })  → src/content/case-studies/{slug}.mdx
    │  Numeric fields rounded to int (Honeycomb payload can carry float imprecision)
    │
    6. git add + commit "feat(case-study): publish {name} ({slug})"
    │
    └→ RunResult { slug, publishedPath, imagePath, estimatedCostUsd, commitSha, … }
```

---

## Humanization validator (`scripts/lib/humanize.ts` + `humanization-rules.ts`)

A regex-based circuit breaker that blocks AI-writing tells. Rules are defined
**once** in `scripts/lib/humanization-rules.ts` and consumed by two places:

1. The validator (`humanize.ts`) — runs as a hard gate in stage 3 of the pipeline
2. The prompt template (`prompts/case-study-prompt.md`) — substituted via
   `{{HUMANIZATION_*}}` placeholders so Claude sees the same rules it is
   validated against

**Rule categories**:
- `not_just_but` — "not just/only/merely/simply X but Y" constructions
- `hedge_phrase` — "it's worth noting", "at the end of the day", "in today's landscape", etc.
- `ai_vocab` — "delve", "tapestry", "groundbreaking", "revolutionize", etc.
- `generic_opener` — "in today's", "in the world of", "imagine a", "picture this", …
- `em_dash_overuse` — density check (> 3 per 500 words)
- `tricolon_list` — density check (> 2 per 500 words)

To add or remove a rule, edit **only** `humanization-rules.ts` — both
consumers update automatically.

---

## Rate limiting (`scripts/lib/ratelimit.ts`)

State file: `.state/ratelimit.json` — `{ "date": "YYYY-MM-DD", "used": N }`.

| Mode | Default cap | Hard max |
|---|---|---|
| Normal (cron + manual + portal) | 3/day | — |
| Backfill override (`--rate=N`) | up to 10/day | 10 |

Day boundary: UTC midnight. Counter auto-resets on first read of a new day.

**Known gap**: `.state/ratelimit.json` is written by `consume()` but not
committed back to the repo. Each new workflow invocation starts with a fresh
0-of-N budget. In practice this hasn't caused over-spend (cron runs once/day;
backfill self-caps; manual ops are infrequent) but the "3/day across all
triggers" semantic is more permissive than intended.

---

## Hero image resolution priority (`scripts/lib/scrape.ts`)

`extractHeroImageUrl(campaign, pageProps, html)` walks six sources in order:

1. `pageProps.ogImageUrl` — canonical top-level OG field (most stable; used by Honeycomb's own social previews)
2. `campaign.ogImageUrl` — same URL inside `campaignData.data` (v3.3 spec)
3. Top-level alternates on campaign: `heroImageUrl`, `coverImageUrl`, `mainImageUrl`, `imageUrl`, `image`
4. `campaignMedia[]` — newer-campaign location; checks `url`, `imageUrl`, `src`, `href`, `fileUrl`
5. Deep-scan `pageProps` up to depth 8 — catches any Honeycomb-uploads URL in sibling structures
6. Rendered HTML `<img src="...storage.googleapis.com/honeycomb-uploads/...">` regex — last resort

Images must contain `storage.googleapis.com/honeycomb-uploads` or a known image extension to match.

---

## GitHub Actions workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `detect.yml` | `schedule: '7 12 * * *'` + manual dispatch | Queries PostHog, runs pipeline for eligible slugs, pushes commits, dispatches `deploy.yml` |
| `deploy.yml` | `push: main` + manual dispatch | `typecheck → test → build → upload artifact → deploy Pages` |
| `on-comment.yml` | `issue_comment: created` | Parses `/funded` slash commands; auth: `OWNER/COLLABORATOR/MEMBER` only |
| `on-issue.yml` | `issues: opened/edited/labeled` | Routes `[Backfill]` and `[Redraft]` Issue Forms; adds `dispatched` label as anti-replay guard |

All content-writing workflows push commits via `git push origin HEAD:main` then
explicitly dispatch `deploy.yml` (because GITHUB_TOKEN-authenticated pushes do
not trigger downstream `push:` workflows — GitHub's recursion safeguard).

---

## Slash commands (operator surface)

All commands accepted in issue/PR comments as `/funded <command> [args]`.
Auth gate: `author_association` must be `OWNER`, `COLLABORATOR`, or `MEMBER`.

| Command | Description | Spend |
|---|---|---|
| `/funded generate <campaign-slug>` | Full pipeline for one campaign | ~$0.45 |
| `/funded redraft <case-study-slug> [feedback…]` | Regenerate with optional single-line feedback | ~$0.45 |
| `/funded delete <case-study-slug>` | Remove MDX + hero image, commit | $0 |
| `/funded status` | Rate limit status + last detection mtime | $0 |
| `/funded cost-estimate <slug…>` | Estimate cost without spending | $0 |
| `/funded inspect <campaign-slug>` | Dump `__NEXT_DATA__` diagnostic | $0 |

For multi-paragraph redraft feedback, use the "Redraft with feedback" Issue Form.

**Note**: `redraft` takes the **case-study slug** (the URL path / MDX filename),
not the Honeycomb campaign slug. `generate` takes the Honeycomb **campaign slug**.

---

## Issue Forms

| Form | Title prefix | Dispatched by |
|---|---|---|
| Backfill case studies | `[Backfill]` | `on-issue.yml` → `scripts/backfill.ts` |
| Redraft with feedback | `[Redraft]` | `on-issue.yml` → `scripts/redraft.ts` |

Routing key is the title prefix, not labels (GitHub silently drops labels from
Issue Forms when they don't yet exist in the repo).

---

## Local development

```bash
nvm use            # Node 20+ (see .nvmrc)
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY, GITHUB_TOKEN, POSTHOG_* as needed
npm run dev        # http://localhost:4321
npm run build      # static output to dist/
npm run typecheck  # astro sync && tsc --noEmit
npm test           # vitest run (65 tests)
```

Running scripts locally (replace `<slug>` with a real Honeycomb campaign slug):

```bash
npx tsx scripts/inspect.ts <slug>            # diagnostic, no spend
npx tsx scripts/generate.ts <slug>           # ~$0.45 spend
npx tsx scripts/redraft.ts <slug> --feedback="..."
npx tsx scripts/delete.ts <slug>
npx tsx scripts/backfill.ts --slugs="A\nB\nC" [--force] [--dry-run] [--rate=N]
npx tsx scripts/detect.ts [--dry-run]        # needs POSTHOG_* env vars
```

---

## File layout

```
src/
  content/
    config.ts                  ← Zod schema; single source of truth for frontmatter
    case-studies/*.mdx         ← one file per published campaign (agent writes here)
  pages/
    [...slug].astro            ← case-study renderer
    index.astro                ← directory listing
    admin/index.astro          ← operator portal (noindex, PAT-auth form UI)
    rss.xml.js                 ← /rss.xml
  layouts/CaseStudy.astro      ← hero + metrics strip + body + CTA
  components/
    BaseHead.astro Hero.astro MetricsStrip.astro Quote.astro
    Cta.astro JsonLd.astro SiteHeader.astro SiteFooter.astro
scripts/
  generate.ts                  ← /funded generate; consumes 1 rate-limit token
  redraft.ts                   ← /funded redraft; pins output slug to preserve URL
  delete.ts                    ← /funded delete; git rm MDX + hero image
  backfill.ts                  ← Issue Form backfill; --rate override up to 10/day
  detect.ts                    ← daily cron entry point; PostHog → pipeline
  inspect.ts                   ← /funded inspect; __NEXT_DATA__ diagnostic, $0
  status.ts                    ← /funded status; rate limit + last cron mtime
  cost-estimate.ts             ← /funded cost-estimate; token estimate, $0
  dispatch-comment.ts          ← parses COMMENT_BODY env, routes to scripts above
  dispatch-issue.ts            ← parses ISSUE_BODY/TITLE env, routes by title prefix
  lib/
    pipeline.ts                ← shared 6-stage pipeline (generate/redraft/backfill)
    claude.ts                  ← Anthropic SDK wrapper; output validation; cost estimate
    humanize.ts                ← AI-tells regex validator (hard gate)
    humanization-rules.ts      ← SINGLE SOURCE OF TRUTH for humanization rules
    posthog.ts                 ← HogQL client; discovery source for funded slugs
    scrape.ts                  ← __NEXT_DATA__ extraction + hero image resolver
    schemas.ts                 ← ClaudeOutputSchema + CampaignSchema + INDUSTRIES
    mdx.ts                     ← MDX read/write; idempotency via campaignSlug scan
    image.ts                   ← fetch + store hero image; remove on delete
    ratelimit.ts               ← .state/ratelimit.json ledger; UTC-day reset
    github.ts                  ← Octokit wrappers (createIssue, addComment, etc.)
    git.ts                     ← child_process git wrapper; bot identity config
    format.ts                  ← formatMoney, formatPercent, formatTimeToFund
    log.ts                     ← structured logger; routes stage() to tracking issue
    args.ts                    ← CLI argument parser (positional + --flag=value)
    parse-slugs.ts             ← backfill textarea parser (strips fences, comments)
    *.test.ts                  ← Vitest tests (65 total across 5 files)
prompts/
  case-study-prompt.md         ← runtime system prompt; {{HUMANIZATION_*}} substituted
public/
  og/                          ← hero/OG images, one per case study
  CNAME                        ← funded.honeycombcredit.com
.github/
  workflows/
    deploy.yml detect.yml on-comment.yml on-issue.yml
  ISSUE_TEMPLATE/
    backfill.yml redraft-with-feedback.yml config.yml
.state/
  detection-log.md             ← daily cron heartbeat (one row per run)
  ratelimit.json               ← today's generation counter (not committed — see Known gaps)
```

---

## Costs

| Operation | Cost |
|---|---|
| Generate or redraft | ~$0.45 (Opus 4.7, ~17K input + ~2.8K output tokens) |
| Inspect / delete / status / cost-estimate | $0 |
| Astro build + Pages deploy | $0 (GitHub Actions free tier) |
| Steady state ~10 campaigns/month | ~$5/month |

---

## Known gaps

1. **Rate-limit persistence is per-run, not per-day.** `.state/ratelimit.json`
   is written by `consume()` but never committed back. Each workflow invocation
   starts fresh. Fix: commit the file in `pipeline.ts`'s commit step (small
   race-condition risk if multiple workflows overlap).

2. **Founder-level input data is absent.** The scrape payload (summary,
   use-of-proceeds, metrics) does not include the founder's name, photo, or
   verbatim Q&A. The "Ask The Founders" tab would unlock this — it's the
   single biggest quality lever still on the roadmap.

3. **Pre-2026 campaigns are not auto-published.** The PostHog HogQL query
   floors at `campaignexpirationdate >= '2026-01-01'`. ~570 historical funded
   campaigns are visible to PostHog but skipped by the cron — use the
   Backfill Issue Form to hand-pick any for publication.
