# CLAUDE.md — Collateral Development Agent

> This file documents the codebase for AI-assisted development. It is meant to be
> comprehensive enough that an AI coding tool can recreate the project from scratch.
> Keep it in sync with the code; the README is the human-facing summary.

## What this project is

`funded.honeycombcredit.com` is a static site that publishes a case study for every
funded Honeycomb Credit campaign. **The repo itself is the agent**: GitHub Actions runs
the detection cron, operators drive ad-hoc actions through GitHub Issues and a web
portal, and the case studies live as MDX files committed to this repo.

- **Live site:** https://funded.honeycombcredit.com
- **Operator portal:** https://funded.honeycombcredit.com/admin
- **Audit log:** GitHub Issues tab (every action, every cron run)
- **Detection log:** `.state/detection-log.md` (append-only; one row per cron run)

**Current operational status (as of 2026-06-09):** The daily cron is paused to stop
background API spend. Manual operations (portal, slash commands, Issue Forms) remain
fully active. All case studies for Jan-2026+ campaigns have been published.

---

## Repository layout

```
case-study-generator/
├── .github/
│   ├── workflows/
│   │   ├── detect.yml             — cron (PAUSED); workflow_dispatch active
│   │   ├── deploy.yml             — Astro build + GitHub Pages deploy
│   │   ├── on-comment.yml         — /funded slash command dispatcher
│   │   └── on-issue.yml           — Issue Form dispatcher
│   └── ISSUE_TEMPLATE/
│       ├── backfill.yml           — batch-process historical slugs
│       ├── redraft-with-feedback.yml
│       └── config.yml
├── .state/
│   ├── detection-log.md           — append-only cron heartbeat
│   └── ratelimit.json             — today's counter (written, not committed)
├── prompts/
│   └── case-study-prompt.md       — 1000-line runtime prompt; sent to Claude on every call
├── public/
│   └── og/                        — hero / OG images ({slug}.{jpg|png|webp|svg})
├── scripts/
│   ├── generate.ts                — CLI: one case study by slug
│   ├── detect.ts                  — CLI: cron entry point (PostHog → pipeline)
│   ├── redraft.ts                 — CLI: regenerate with operator feedback
│   ├── delete.ts                  — CLI: remove a published case study
│   ├── backfill.ts                — CLI: batch-process a list of slugs
│   ├── inspect.ts                 — CLI: diagnostic; no API spend
│   ├── cost-estimate.ts           — CLI: estimate Claude spend
│   ├── status.ts                  — CLI: print today's rate-limit status
│   ├── dispatch-comment.ts        — internal: /funded slash command handler
│   ├── dispatch-issue.ts          — internal: Issue Form handler
│   └── lib/
│       ├── pipeline.ts            ← CORE: 6-stage per-slug generation pipeline
│       ├── claude.ts              — Anthropic SDK wrapper + prompt loading
│       ├── humanize.ts            — AI-writing tell validator
│       ├── humanization-rules.ts  ← SINGLE SOURCE OF TRUTH: banned words/phrases
│       ├── posthog.ts             — HogQL client: "which slugs are funded?"
│       ├── scrape.ts              — invest.honeycombcredit.com/__NEXT_DATA__ extractor
│       ├── ratelimit.ts           — 1/day default, 10/day backfill cap
│       ├── mdx.ts                 — MDX read/write; idempotency by campaignSlug
│       ├── github.ts              — Octokit wrappers (issues, labels, comments)
│       ├── image.ts               — hero image fetch + store under public/og/
│       ├── git.ts                 — git add/commit helpers
│       ├── schemas.ts             — CampaignSchema, ClaudeOutputSchema (Zod)
│       ├── parse-slugs.ts         — backfill slug input parser
│       ├── format.ts              — formatMoney, formatTimeToFund, todayISO
│       ├── log.ts                 — stage()/info()/warn() + tracking issue
│       ├── args.ts                — parseArgs() CLI argument helper
│       └── *.test.ts              — 65 unit tests (vitest)
├── src/
│   ├── content/
│   │   ├── case-studies/          ← agent writes here; one .mdx per campaign
│   │   └── config.ts              ← SINGLE SOURCE OF TRUTH: MDX frontmatter schema
│   ├── pages/
│   │   ├── [...slug].astro        — case-study detail renderer
│   │   ├── index.astro            — campaign directory page
│   │   ├── admin/index.astro      — operator portal (noindex; static HTML/JS)
│   │   └── rss.xml.js             — /rss.xml
│   ├── layouts/
│   │   └── CaseStudy.astro        — BaseHead → Header → Hero → MetricsStrip → body → Cta → Footer → JsonLd
│   └── components/
│       ├── Hero.astro             — h1 + subhead + hero image
│       ├── MetricsStrip.astro     — 3 tiles: Raised (yellow) / Investors / Time to fund
│       ├── Quote.astro            — optional founder quote (hidden when absent)
│       ├── Cta.astro              — pre-qualify CTA; UTM href computed from campaignSlug
│       ├── JsonLd.astro           — <script type="application/ld+json">
│       ├── BaseHead.astro         — <head>: meta, OG, canonical, robots
│       ├── SiteHeader.astro
│       └── SiteFooter.astro
├── tailwind.config.mjs            — Honeycomb brand palette
├── astro.config.mjs               — build config; sitemap excludes /admin
├── tsconfig.json                  — strict + noUncheckedIndexedAccess
├── vitest.config.mts
└── package.json                   — name: funded-honeycombcredit; v4.0.0; Node >=20
```

---

## Core pipeline (scripts/lib/pipeline.ts)

The six-stage per-slug generation pipeline is shared by `generate.ts`, `redraft.ts`,
`backfill.ts`, and `detect.ts`. All four differ only in argument source and
pre-conditions; the business logic lives here once.

```
Stage 1 — Scrape
  fetchCampaign(slug) → CampaignSchema
  Source: invest.honeycombcredit.com/{slug} via __NEXT_DATA__ extraction.
  Fails fast if required fields (city/state/target/summary) are absent.

Stage 2+3 — Claude + humanization (loop up to MAX_HUMANIZATION_ATTEMPTS=2)
  generateCaseStudy(payload) → ClaudeOutput (14-key JSON)
  validateCopy(story) — regex against humanization-rules.ts
  On fail: retry with flagged issues spliced into redraftFeedback.
  On second fail: publish anyway; caller applies humanization-warning label.

Stage 4 — Image
  extractHeroImageUrl(campaign, pageProps, html) — 6-level fallback chain
  fetchAndStoreHeroImage() → public/og/{slug}.{ext}

Stage 5 — MDX
  writeCaseStudy({ slug, frontmatter, body }) → src/content/case-studies/{slug}.mdx
  Frontmatter: all scraped + Claude fields (25+ fields).
  Body: claude.output.story (rich-text HTML).

Stage 6 — Commit
  git add {mdx file} {image file}
  git commit "feat(case-study): publish {name} ({slug})"
```

**Retry policy:** `MAX_HUMANIZATION_ATTEMPTS = 2`. First humanization fail → retry once with
validator feedback. Second fail → publish anyway, set `humanizationWarnings` in RunResult.
The prompt (`case-study-prompt.md §13.5`) calls this a "hard gate" — that framing is
intentional model motivation. The system-level two-strikes fallback is invisible to the model.

---

## Content schema (src/content/config.ts)

This Zod schema is the **single source of truth** for all MDX frontmatter. A build-time
failure here prevents a malformed page from reaching production.

### Fields

| Field | Type | Source | Notes |
|---|---|---|---|
| `businessName` | string | scrape | campaign name |
| `niche` | string (2-80) | Claude | specific business niche |
| `industry` | enum | Claude | see controlled vocabulary below |
| `city` | string | scrape | |
| `state` | string (2-char uppercase) | scrape | US state abbreviation |
| `h1Heading` | string (≥20) | Claude | |
| `heroSubhead` | string (≥20) | Claude | |
| `storyHeading` | string (≥4) | Claude | |
| `heroImage` | `/og/...` path | pipeline | stored under public/og/ |
| `heroImageAlt` | string (8-200) | Claude | |
| `ogImage` | `/og/...` path? | pipeline | usually same as heroImage |
| `quote` | string? | — | optional; layout hides when absent |
| `quoteAttribution` | string? | — | optional |
| `amountRaised` | int | scrape | Math.round() applied |
| `amountRaisedFormatted` | string | pipeline | e.g. "$125,000" |
| `investorCount` | int | scrape | Math.round() applied |
| `timeToFund` | string | pipeline | e.g. "21 days", "under a week" |
| `metaTitle` | string (40-70) | Claude | |
| `metaDescription` | string (120-180) | Claude | |
| `ogTitle` | string (30-80) | Claude | |
| `ogDescription` | string (60-160) | Claude | |
| `canonicalOverride` | URL? | — | optional |
| `ctaText` | string (≥3) | Claude | button label only; no ctaUrl |
| `campaignUrl` | URL | pipeline | invest.honeycombcredit.com/{slug} |
| `campaignId` | string | scrape | |
| `campaignSlug` | string | scrape | idempotency key for mdx.ts |
| `publishedDate` | date | pipeline | today's ISO date |
| `systemSchemaJson` | object or array | Claude | JSON-LD (LocalBusiness + Article) |

**Removed in v4.0:** `ctaUrl` (Cta.astro builds the href from `campaignSlug` + UTM
constant). `goalAmount`, `goalAmountFormatted`, `percentOfGoal`, `percentOfGoalFormatted`
(progress-to-goal metric removed Jun 2026; MetricsStrip now shows 3 tiles only).

### Industry controlled vocabulary

Additive only — never rename or remove an existing value (would orphan existing MDX files).
Must stay in sync with `prompts/case-study-prompt.md §8`.

```
Food & Beverage | Retail | Health & Wellness | Personal Services
Professional Services | Arts & Entertainment | Manufacturing & Craft
Agriculture | Hospitality | Technology | Education | Other
```

---

## Claude integration (scripts/lib/claude.ts)

**Default model:** `claude-opus-4-7`
Override via `CASE_STUDY_MODEL` env var (e.g., `claude-sonnet-4-6` for cheaper testing).

**Prompt loading:** `prompts/case-study-prompt.md` is loaded once per process.
`{{HUMANIZATION_BANNED_VOCABULARY}}`, `{{HUMANIZATION_BANNED_HEDGE_PHRASES}}`, and
`{{HUMANIZATION_BANNED_OPENERS}}` placeholders are replaced from `humanization-rules.ts`
via `applyPromptSubstitutions()` before the first API call.

**Output contract:** Claude must return a single JSON object with exactly 14 keys (no
preamble, no commentary). Validated against `ClaudeOutputSchema` in `schemas.ts`. The 14
keys are: `slug`, `niche`, `industry`, `h1Heading`, `heroSubhead`, `storyHeading`,
`heroImageAlt`, `metaTitle`, `metaDescription`, `ogTitle`, `ogDescription`, `ctaText`,
`story` (HTML body), `systemSchemaJson` (JSON-LD).

**JSON-LD shapes accepted** (validated in `isValidJsonLd()`):
- Array of typed objects: `[{"@type":...}, ...]` — canonical per prompt §9
- Single typed object: `{"@context":..., "@type":...}`
- `@graph` wrapper: `{"@context":..., "@graph":[...]}`
- Max 8000 chars serialized.

**Pricing constants** (update in `PRICING` map when changing model):
- `claude-opus-4-7`: $15 input / $75 output per Mtok
- `claude-sonnet-4-6`: $3 input / $15 output per Mtok
- `claude-haiku-4-5-20251001`: $1 input / $5 output per Mtok
- Typical cost per generation: ~$0.45 (Opus 4.7; ~17K input + ~2.7K output tokens)

---

## Humanization system

### humanization-rules.ts — single source of truth

Both consumers derive from this one file:
- `humanize.ts` — builds the regex validator
- `claude.ts` — substitutes rule lists into the runtime prompt

**To add a banned word/phrase:** add a `PhrasePattern` entry to the relevant list.
It propagates to both the validator and the next generation's prompt automatically.
Never hardcode banned strings in the prompt or validator.

### Lists in humanization-rules.ts

- `BANNED_VOCABULARY` — AI-tell words (e.g., "delve", "tapestry", "groundbreaking")
- `BANNED_HEDGE_PHRASES` — meta-commentary phrases ("it's worth noting", etc.)
- `BANNED_OPENERS` — paragraph/sentence openers ("Have you ever…", "Picture this…")
- `DENSITY_RULES` — soft caps per 500 words: tricolons (~2), em-dashes (~3)

### Validator behavior (humanize.ts)

`validateCopy(plainText)` returns `{ passed: boolean; issues: HumanizationIssue[] }`.
Issues carry `type`, `pattern`, `matches[]`, and `message` for reviewer display.

`formatIssuesForReviewer(issues)` formats them as bullet points for the retry feedback
passed back to Claude as `redraftFeedback`.

---

## Discovery (scripts/lib/posthog.ts)

**Source:** PostHog HogQL query against `postgres.campaigns` (Fivetran-mirrored).

```sql
SELECT slug, campaignname, campaignstage, campaignexpirationdate AS fundedat
FROM postgres.campaigns
WHERE campaignstage IN ('Funded', 'Successful - Finalizing')
  AND _fivetran_deleted = false
  AND deletedat IS NULL
  AND campaignexpirationdate >= '2026-01-01'
ORDER BY campaignexpirationdate DESC
LIMIT 1000
```

**Why PostHog, not listing scrape?** The invest.honeycombcredit.com listing shows only
~10 active campaigns at a time. PostHog's Fivetran mirror returns every funded campaign
ever, including ones that funded while off the listing window.

**2026-01-01 floor:** Pre-2026 campaigns (~570) are intentionally excluded from the cron.
Tyler hand-picks historical case studies via the Backfill Issue Form.

**Column used for fund date:** `campaignexpirationdate` (the scheduled close date).
`updatedat` was considered but ruled out as noisy — old Funded records get touched for
admin/repayment reasons unrelated to the funding event.

---

## Rate limiting (scripts/lib/ratelimit.ts)

**State file:** `.state/ratelimit.json` — shape: `{ "date": "2026-04-28", "used": 2 }`.
Written by `consume()` but **not committed** back to the repo. Each new workflow
invocation reads ENOENT and starts at used=0.

**Default cap:** 1 generation per UTC day (resets at UTC midnight).
**Backfill override:** up to 10/day (hard max enforced by `HARD_MAX_OVERRIDE`).

**Known gap:** The per-invocation reset means the "1/day across all triggers" semantic
is only enforced within a single workflow run, not globally. In practice no over-spend
has occurred (cron runs once/day; backfill self-caps; manual ops are infrequent).
Fix: commit `.state/ratelimit.json` in pipeline.ts's git stage.

---

## GitHub workflows

### detect.yml — cron / workflow_dispatch

Currently **PAUSED**: both `schedule:` slots are commented out. Resume by uncommenting
the `schedule:` block. The two slots (04:47 UTC + 11:23 UTC) exist because GitHub
Actions may silently drop or delay a single scheduled slot; running twice/day costs
nothing when the first run lands cleanly (already-published campaigns are idempotent).

Flow:
1. `npm ci`
2. `npx tsx scripts/detect.ts [--dry-run]`
3. `git push origin HEAD:main` (capture output)
4. If content was pushed: `gh workflow run deploy.yml --ref main`

Note: pushes via `GITHUB_TOKEN` don't trigger downstream `push:` workflows (GitHub's
recursion safeguard). `workflow_dispatch` is the exception, which is why deploy.yml is
explicitly dispatched here.

### deploy.yml — push to main / workflow_dispatch

1. `npm run typecheck` (`astro sync && tsc --noEmit`)
2. `npm test` (65 vitest tests)
3. `npm run build` (Astro → dist/)
4. `actions/upload-pages-artifact` + `actions/deploy-pages`

Concurrency group `pages` with `cancel-in-progress: false` prevents clobbering a
deploy in flight.

### on-comment.yml — /funded slash commands

**Auth gate:** `author_association` must be `OWNER`, `COLLABORATOR`, or `MEMBER`.
Non-collaborators are silently ignored (no comment, no reaction).

**Commands** (parsed by `dispatch-comment.ts`):
```
/funded generate <slug>
/funded redraft <slug> --feedback="..."
/funded delete <slug>
/funded inspect <slug>
/funded status
/funded cost-estimate [--model=<model>] [--count=N]
```

Flow: react with 👀 → checkout → `npx tsx scripts/dispatch-comment.ts` → push if
content changed → `gh workflow run deploy.yml` if pushed.

### on-issue.yml — Issue Form dispatcher

Routes by issue title prefix to `dispatch-issue.ts`, which handles:
- "Backfill case studies" — calls `backfill.ts` with slugs + options from form body
- "Redraft with feedback" — calls `redraft.ts` with slug + feedback from form body

---

## Environment variables

| Variable | Required for | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | generate, redraft, backfill, detect | Claude API key |
| `GITHUB_TOKEN` | all scripts | Auto-provided in CI; set locally for issue ops |
| `POSTHOG_API_KEY` | detect | Personal API key; `project:query:read` scope |
| `POSTHOG_PROJECT_ID` | detect | Numeric project ID (Honeycomb Credit Production) |
| `CASE_STUDY_MODEL` | generate, redraft, backfill, detect | Optional; default `claude-opus-4-7` |
| `POSTHOG_HOST` | detect | Optional; default `https://us.posthog.com` |
| `FUNDED_BOT_IDENTITY` | detect, on-comment, on-issue | Set to `1` in CI for bot commit identity |

See `.env.example` for local setup.

---

## Key architectural invariants

1. **One pipeline, four entry points.** `detect.ts`, `generate.ts`, `redraft.ts`, and
   `backfill.ts` all call `runPipeline()`. No duplicated business logic.

2. **Zod at every boundary.** Three layers: (1) `src/content/config.ts` at Astro build
   time, (2) `schemas.ts ClaudeOutputSchema` at generation time, (3) `schemas.ts
   CampaignSchema` at scrape time. If any layer fails, the content never reaches
   production.

3. **Idempotent by campaignSlug.** `mdx.ts` keys by the `campaignSlug` frontmatter
   field. Re-running `generate` on an already-published campaign finds the existing MDX
   and overwrites it (without `--force`, it bails). File names use Claude's chosen slug;
   `redraft` forces the original slug to preserve the public URL.

4. **humanization-rules.ts is the only source.** Never hardcode banned words/phrases in
   `case-study-prompt.md` or `humanize.ts`. Add to the rules file; both consumers update.

5. **ctaUrl is computed, not stored.** `Cta.astro` builds the UTM-tagged href from
   `campaignSlug` + a constant base URL. There is no `ctaUrl` frontmatter field.

6. **Images under public/og/.** `heroImage` is always a string path (not an Astro
   `image()` object) because `public/` assets are served unprocessed. `image.ts` uses
   plain `fs.writeFile`, keeping the image-write logic simple.

7. **GitOps audit trail.** Every action produces a git commit. The deployment is GitHub
   Pages serving `main`. The Issues tab is the operator log. Together they form a
   complete audit trail with no external database.

8. **Industries are additive-only.** Adding a new industry to the enum in `config.ts`
   and the prompt is safe. Renaming or removing one would orphan existing MDX files that
   reference the old value and break the build.

---

## Adding a new case study

### Via operator portal (recommended)
https://funded.honeycombcredit.com/admin — enter the campaign slug, click Generate.

### Via slash command
In any GitHub issue/PR comment (must be repo collaborator):
```
/funded generate <campaign-slug>
```

### Via CLI
```bash
ANTHROPIC_API_KEY=... GITHUB_TOKEN=... npx tsx scripts/generate.ts <campaign-slug>
```

The `<campaign-slug>` is the Honeycomb campaign URL slug
(e.g., `saucy-african-west-african-simmer-sauces`).

---

## Regenerating with feedback

```
/funded redraft <slug> --feedback="The opening reads too generic. Lead with the founder's background as a West African chef."
```

Or via Issue Form: Issues → New → "Redraft with feedback".

Redraft preserves the existing public URL by passing `forcedOutputSlug` to the pipeline.

---

## Backfilling historical campaigns

For campaigns pre-dating Jan 2026 (invisible to the cron) or any batch operation:

```
Issues → New → "Backfill case studies"
```

Or via CLI:
```bash
npx tsx scripts/backfill.ts --slugs="slug-one\nslug-two\nslug-three" [--force] [--dry-run] [--rate=5]
```

`--rate` overrides the daily cap (hard max 10). `--force` overwrites existing MDX.
`--dry-run` scrapes and validates without writing or spending.

---

## Local development

```bash
nvm use               # Node 20+ (see .nvmrc)
npm install
npm run dev           # http://localhost:4321
npm run build         # static output → dist/
npm run typecheck     # astro sync && tsc --noEmit
npm test              # vitest run (65 tests)
npm run test:watch    # vitest watch mode
```

---

## Diagnostics

```bash
# Scrape and validate a campaign without spending API credits
npx tsx scripts/inspect.ts <slug>

# Print today's rate-limit status
npx tsx scripts/status.ts

# Estimate Claude cost for N generations
npx tsx scripts/cost-estimate.ts [--model=claude-opus-4-7] [--count=10]

# Run the cron discovery scan without generating anything
npx tsx scripts/detect.ts --dry-run
```

---

## Known gaps

| Gap | Impact | Fix |
|---|---|---|
| Rate-limit state not committed | "1/day across all triggers" is per-invocation, not global | Commit `.state/ratelimit.json` in pipeline.ts's git stage; handle race conditions |
| Pre-2026 campaigns are manual-only | ~570 historical campaigns require Backfill Issue Form | PostHog floor date can be changed; Tyler chose manual for historical batch |
| Founder Q&A input not scraped | Claude works from summary HTML only; no name/photo/verbatim quotes | Pull from "Ask The Founders" tab — highest-leverage quality improvement on roadmap |
| Humanization gate soft on second attempt | A draft that still fails after retry publishes with warning label | Prompt describes it as hard gate (model motivation); system fallback intentional |
| Scrape fragile to Honeycomb frontend changes | `__NEXT_DATA__` shape change breaks `CampaignSchema` | `CampaignSchema` validates field presence explicitly; 6-level image fallback provides resilience |

---

## Tech stack

| Layer | Technology | Version |
|---|---|---|
| Site framework | Astro | 5.1.5 |
| Content | MDX via @astrojs/mdx | 4.0.3 |
| Styles | Tailwind CSS | 3.4.17 |
| Fonts | Raleway (display) + Open Sans (body) | @fontsource/* |
| Language | TypeScript (strict, noUncheckedIndexedAccess) | 5.7.2 |
| AI | Anthropic SDK | 0.65.0 |
| GitHub API | @octokit/rest | 21.0.2 |
| Schema validation | Zod | 3.24.1 |
| YAML parsing | yaml | 2.7.0 |
| CLI runner | tsx | 4.19.2 |
| Test runner | Vitest | 2.1.8 |
| Node | >=20.0.0 | (see .nvmrc) |
| Hosting | GitHub Pages (from private repo via GitHub Pro) | — |
