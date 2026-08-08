# CLAUDE.md — Collateral Development Agent v4.0

Technical reference for AI tools. This file contains everything needed to understand
and recreate the project: architecture, data flow, all source files with their
contracts, schema definitions, workflow descriptions, and known gaps.

---

## Project Overview

**funded.honeycombcredit.com** — An autonomous multi-agent system that automatically
publishes case studies for funded Honeycomb Credit campaigns as a static site.

**The repo is the agent.** GitHub Actions runs the detection cron; operators drive
ad-hoc actions through GitHub Issues and a browser-based portal; case studies live
as MDX files committed directly to this repo.

### Key surfaces

| Surface | URL |
|---|---|
| Live site | https://funded.honeycombcredit.com |
| Operator portal | https://funded.honeycombcredit.com/admin |
| Audit log | https://github.com/tylerhoneycomb/case-study-generator/issues |
| Cron heartbeat | `.state/detection-log.md` |

### Current operational status

**Daily cron is paused** as of 2026-06-09 to stop Anthropic API spend while the
project is on hold. The `workflow_dispatch` trigger on `detect.yml` remains active
for manual runs. To resume: uncomment the `schedule:` block in
`.github/workflows/detect.yml`.

---

## Architecture

Two concerns share a single repo:

1. **The agent** (`scripts/`) — TypeScript CLI programs that discover funded campaigns,
   generate case-study content via Claude, validate it, fetch assets, and commit MDX
   files plus images to the repo.
2. **The site** (`src/`) — An Astro 5 static site that renders the committed MDX files
   as case-study pages and deploys them to GitHub Pages on every push to `main`.

### High-level data flow

```
PostHog (Fivetran-mirrored postgres.campaigns)
    │
    │ fetchFundedCampaigns()
    ▼
detect.ts — filter against published, apply rate-limit
    │
    │ runPipeline(slug)
    ▼
scripts/lib/pipeline.ts:
  Stage 1  fetchCampaign(slug)           ← invest.honeycombcredit.com __NEXT_DATA__
  Stage 2  generateCaseStudy(payload)    ← Claude Opus 4.7 + prompts/case-study-prompt.md
  Stage 3  validateCopy(story)           ← humanization validator; retry once on fail
  Stage 4  fetchAndStoreHeroImage()      ← public/og/{slug}.{ext}
  Stage 5  writeCaseStudy()              ← src/content/case-studies/{slug}.mdx
  Stage 6  git add + commit + push
    │
    │ push to main
    ▼
deploy.yml — typecheck → test → astro build → GitHub Pages
    │
    ▼
funded.honeycombcredit.com (live in ~2 minutes)
```

---

## Technology Stack

### Site / build
- **Astro 5** (`^5.1.5`) — static site generator, MDX content collections
- **Tailwind CSS 3.4** (`^3.4.17`) — utility-first styling; custom brand tokens
  (`honeycomb-yellow`, `honeycomb-ink`, `honeycomb-cream`, `honeycomb-purple`, `honeycomb-green`)
- **TypeScript 5.7** — strict mode, `noUncheckedIndexedAccess: true`
- **MDX** — case-study content format (YAML frontmatter + HTML body)
- **Fonts:** Open Sans (body), Raleway (display headings)

### Agent / CLI
- **Node 20+** (`.nvmrc`)
- **tsx** (`^4.19.2`) — runs TypeScript CLIs without a compile step
- **Anthropic SDK** (`@anthropic-ai/sdk ^0.65`) — Claude API client
- **Octokit** (`@octokit/rest ^21`) — GitHub Issues / comments / labels
- **Zod** (`^3.24`) — runtime schema validation
- **yaml** (`^2.7`) — MDX frontmatter serialization

### Testing
- **Vitest** (`^2.1`) — 57 unit tests, run on every deploy

### Hosting / CI
- **GitHub Pages** — static hosting; custom domain via `public/CNAME`
- **GitHub Actions** — cron detection, Astro build+deploy, slash-command and issue-form dispatchers

---

## Directory Structure

```
case-study-generator/
├── src/
│   ├── components/
│   │   ├── BaseHead.astro        # <head>: title, meta, OG, canonical, JSON-LD
│   │   ├── Hero.astro            # Page hero: H1 + subhead + hero image
│   │   ├── MetricsStrip.astro    # Three-tile grid: Raised / Investors / Time to fund
│   │   ├── Quote.astro           # Optional founder quote block (hidden when absent)
│   │   ├── Cta.astro             # Pre-qualify CTA button (UTM-tagged href; no ctaUrl in frontmatter)
│   │   ├── JsonLd.astro          # <script type="application/ld+json"> emitter
│   │   ├── SiteHeader.astro      # Nav header
│   │   └── SiteFooter.astro      # Footer
│   ├── layouts/
│   │   └── CaseStudy.astro       # Master layout: BaseHead + Hero + MetricsStrip + body + Cta
│   ├── pages/
│   │   ├── index.astro           # Directory listing of all published case studies
│   │   ├── [...slug].astro       # Dynamic renderer — one route per MDX file
│   │   ├── rss.xml.js            # /rss.xml feed
│   │   └── admin/
│   │       └── index.astro       # Operator portal (noindex; browser-only, no backend)
│   ├── content/
│   │   ├── case-studies/         # ← agent writes here; one .mdx per funded campaign
│   │   └── config.ts             # Zod schema: single source of truth for frontmatter
│   └── styles/
│       └── global.css            # Tailwind base imports + font imports
│
├── scripts/
│   ├── generate.ts               # Generate one case study from a campaign slug
│   ├── detect.ts                 # Daily cron entry point (PostHog → per-slug pipeline)
│   ├── redraft.ts                # Regenerate an existing case study with feedback
│   ├── delete.ts                 # Remove a published case study
│   ├── backfill.ts               # Batch-generate historical campaigns
│   ├── inspect.ts                # Diagnostic scrape + validate (no Claude call, no commit)
│   ├── status.ts                 # Print today's rate-limit status
│   ├── cost-estimate.ts          # Estimate total cost for a newline-separated slug list
│   ├── dispatch-comment.ts       # GitHub Actions: parse + route slash-command comments
│   ├── dispatch-issue.ts         # GitHub Actions: parse + route issue-form submissions
│   └── lib/
│       ├── claude.ts             # Anthropic SDK wrapper (generateCaseStudy)
│       ├── pipeline.ts           # Shared per-slug pipeline (all generation commands use this)
│       ├── posthog.ts            # PostHog HogQL client — funded campaign discovery
│       ├── scrape.ts             # invest.honeycombcredit.com __NEXT_DATA__ scraper
│       ├── humanize.ts           # AI-tell regex validator
│       ├── humanization-rules.ts # Banned-phrase lists and density thresholds (shared w/ prompt)
│       ├── mdx.ts                # MDX file read/write/delete; idempotency by campaignSlug
│       ├── image.ts              # Hero/OG image fetch + store under public/og/
│       ├── ratelimit.ts          # UTC daily rate-limit ledger
│       ├── github.ts             # Octokit wrappers: createIssue, addComment, addLabel, etc.
│       ├── git.ts                # Git operations: add, commit, push, rm, commitSha
│       ├── log.ts                # Structured logging: posts to tracking issue + console
│       ├── format.ts             # formatMoney, formatTimeToFund, todayISO
│       ├── schemas.ts            # Zod schemas: ClaudeOutput, Campaign, ListingEntry
│       ├── args.ts               # CLI argument parser (positionals + named flags)
│       ├── parse-slugs.ts        # Backfill input parser (defends against code-fence drift)
│       └── *.test.ts             # Unit tests co-located with source
│
├── public/
│   ├── og/                       # Hero / OG images — one per case study ({slug}.{ext})
│   └── CNAME                     # funded.honeycombcredit.com
│
├── .github/
│   ├── workflows/
│   │   ├── detect.yml            # Daily cron (currently paused) + manual dispatch
│   │   ├── deploy.yml            # Astro build + GitHub Pages deploy on push to main
│   │   ├── on-comment.yml        # /funded slash-command dispatcher
│   │   └── on-issue.yml          # Issue-form dispatcher (Backfill / Redraft routes)
│   └── ISSUE_TEMPLATE/
│       ├── backfill.yml          # Backfill issue form — batch historical campaigns
│       ├── redraft-with-feedback.yml  # Redraft issue form — structured feedback
│       └── config.yml            # Issue template config
│
├── .state/
│   ├── detection-log.md          # Cron heartbeat (one row per run; committed)
│   └── ratelimit.json            # Today's generation counter (written but NOT committed)
│
├── prompts/
│   └── case-study-prompt.md      # ~1,000-line runtime system prompt sent to Claude
│
├── CLAUDE.md                     # This file
├── README.md                     # Operator-facing overview, quickstart, operator guide
├── package.json                  # Scripts, dependencies
├── astro.config.mjs              # Site URL, integrations (MDX, Tailwind, Sitemap)
├── tailwind.config.mjs           # Custom brand colors and font stacks
├── tsconfig.json                 # Extends astro/strict; noUncheckedIndexedAccess; paths: ~/→src/
├── vitest.config.mts
├── .env.example                  # ANTHROPIC_API_KEY, GITHUB_TOKEN
├── .nvmrc                        # Node 20+
└── .gitignore
```

---

## Per-Slug Pipeline

`scripts/lib/pipeline.ts` — the central orchestrator. Every generation command
(`generate`, `detect`, `backfill`, `redraft`) calls `runPipeline(opts)`.

### Stage sequence

| Stage | What happens |
|---|---|
| 1. Fetch | `fetchCampaign(slug)` → scrape `invest.honeycombcredit.com`, validate against `CampaignSchema` |
| 2. Claude | `generateCaseStudy(payload)` → call Opus 4.7, validate response against `ClaudeOutputSchema` |
| 3. Humanize | `validateCopy(story)` → regex AI-tell checks; retry once with feedback on fail |
| 4. Hero image | `fetchAndStoreHeroImage()` → write to `public/og/{slug}.{ext}` |
| 5. Write MDX | `writeCaseStudy()` → write `src/content/case-studies/{slug}.mdx` |
| 6. Commit | `git add` + `git commit` (`feat(case-study): publish {name} ({slug})`) |

### Humanization retry policy

- **Attempt 1 (clean path):** generate → validate → pass → continue
- **Attempt 1 (fail path):** generate → validate → fail → splice flagged issues into
  `redraftFeedback` → re-call Claude (attempt 2)
- **Attempt 2 (fail path):** generate → validate → still failing → **publish anyway**,
  return `humanizationWarnings` in `RunResult`; caller applies `humanization-warning` label

The model is not told about the system-level fallback (publishing on final failure).
The prompt frames the validator as a hard gate to maximize compliance per attempt.

Constant: `MAX_HUMANIZATION_ATTEMPTS = 2`

### TypeScript interfaces

```typescript
interface RunOptions {
  slug: string;             // Honeycomb campaign slug passed to fetchCampaign()
  feedback?: string;        // Caller-supplied feedback (redraft path)
  skipFundedCheck?: boolean; // Backfill sets true; historical campaigns may not be 'Funded'
  forcedOutputSlug?: string; // Redraft sets this to preserve the existing public URL
}

interface RunResult {
  slug: string;
  publishedPath: string;        // src/content/case-studies/{slug}.mdx
  imagePath: string;            // /og/{slug}.{ext} (root-relative)
  estimatedCostUsd: number;     // Summed across all Claude attempts
  inputTokens: number;
  outputTokens: number;
  commitSha: string;
  attempts: number;             // 1 on clean run, 2 on retry
  humanizationWarnings?: HumanizationIssue[]; // Present when final draft still failed
}

class PipelineError extends Error {
  constructor(public readonly stage: string, message: string)
  // stage values: 'scrape', 'precheck', 'claude', 'image'
}
```

---

## Source File Reference

### `scripts/lib/claude.ts` — Anthropic Client

Loads `prompts/case-study-prompt.md` once per process (cached), applies
`applyPromptSubstitutions()` to resolve `{{HUMANIZATION_*}}` placeholders, then
sends it as the Claude `system` message.

```typescript
// Main export
async function generateCaseStudy(payload: InputPayload): Promise<GenerateResult>

interface InputPayload {
  campaignName: string;
  campaignSlug: string;
  campaignId: string;
  todayISO: string;              // ISO 8601 date
  city: string;
  state: string;                 // 2-letter uppercase US state abbreviation
  totalFundsRaised: number;
  campaignTargetAmount: number;
  numInvestors: number;
  campaignStartDate: string;
  campaignExpirationDate: string;
  summary: string;               // HTML blob from campaign page
  useOfProceeds?: string;
  issuerWebsite?: string;
  issuerDescription?: string;
  ogImageUrl?: string;
  redraftFeedback?: string;      // Retry and redraft paths only
}

interface GenerateResult {
  output: ClaudeOutput;           // Validated 14-key response
  systemSchemaJsonParsed: unknown; // JSON-LD entities, already parsed
  usage: ClaudeUsage;
  raw: string;                    // Raw model response for debugging
}

interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

// Cost estimator (no API call) — used by cost-estimate.ts
function estimateCostForGeneration(model?: string): number  // ≈ $0.45 default

class ClaudeError extends Error {
  name: string  // 'EMPTY_RESPONSE' | 'JSON_PARSE_FAILED' | 'OUTPUT_VALIDATION_FAILED'
                // | 'SYSTEM_SCHEMA_PARSE_FAILED' | 'SYSTEM_SCHEMA_SHAPE' | 'SYSTEM_SCHEMA_TOO_LARGE'
}
```

**Environment variables:**
- `ANTHROPIC_API_KEY` — required for any generation
- `CASE_STUDY_MODEL` — optional, overrides default model

**Pricing table (USD per million tokens):**

| Model | Input | Output | Notes |
|---|---|---|---|
| `claude-opus-4-7` | $15 | $75 | Default; ~$0.45 per case study |
| `claude-sonnet-4-6` | $3 | $15 | A/B testing alternative |
| `claude-haiku-4-5-20251001` | $1 | $5 | A/B testing alternative |

Update the `PRICING` record in `claude.ts` when switching models.

**JSON-LD validation (`isValidJsonLd`):** Accepts three shapes:
1. `[{@type: ...}, ...]` — array of typed entities (prompt-canonical)
2. `{@context: ..., @graph: [...]}` — legacy `@graph` wrapper
3. `{@context: ..., @type: ...}` — single typed entity

---

### `scripts/lib/schemas.ts` — Runtime Zod Schemas

**`ClaudeOutputSchema`** — validates Claude's 14-key JSON response:

| Key | Type / Constraint |
|---|---|
| `h1Heading` | string, 6–14 words |
| `heroSubhead` | string, 8–16 words |
| `storyHeading` | string, 4–10 words |
| `niche` | string, 2–80 chars |
| `industry` | `z.enum(INDUSTRIES)` — one of 12 controlled values |
| `story` | string, HTML, 800–1,200 words |
| `slug` | string, lowercase-hyphenated, 3–6 words |
| `heroImageAlt` | string, 8–200 chars |
| `metaTitle` | string, 40–70 chars |
| `metaDescription` | string, 120–180 chars |
| `ogTitle` | string, 30–80 chars |
| `ogDescription` | string, 60–160 chars |
| `ctaText` | string, 3–7 words |
| `systemSchemaJson` | object or array (JSON-LD); ≤ 8,000 chars serialized |

**`CampaignSchema`** — validates the scrape payload from `invest.honeycombcredit.com`.
Defensive parsing: explicit field-presence checks catch `__NEXT_DATA__` shape changes
before they corrupt MDX files.

**`INDUSTRIES`** controlled vocabulary (12 values, additive-only — never rename):
```
Food & Beverage, Retail, Health & Wellness, Personal Services,
Professional Services, Arts & Entertainment, Manufacturing & Craft,
Agriculture, Hospitality, Technology, Education, Other
```

This list is mirrored in `src/content/config.ts` (build-time) and
`prompts/case-study-prompt.md §8` (runtime prompt). All three must stay in sync.

---

### `scripts/lib/humanize.ts` — AI-Tell Validator

```typescript
function validateCopy(plainText: string): HumanizationResult
// { passed: boolean, issues: HumanizationIssue[], wordCount: number }

function stripHtml(richText: string): string
// Remove tags and HTML entities; produces plain text for validator input

function formatIssuesForReviewer(issues: HumanizationIssue[]): string
// Format issues for GitHub issue body or model redraftFeedback
```

---

### `scripts/lib/humanization-rules.ts` — AI-Tell Rules

Single source of truth shared between the validator and the runtime prompt.

```typescript
function buildAITells(): AITell[]
// Returns all rule objects. Called by validateCopy() and applyPromptSubstitutions().

function applyPromptSubstitutions(raw: string): string
// Resolves {{HUMANIZATION_*}} placeholders in the prompt text:
//   {{HUMANIZATION_BANNED_PHRASES}}     → formatted list of banned words/phrases
//   {{HUMANIZATION_EM_DASH_THRESHOLD}}  → em-dash density cap (e.g., "2")
//   {{HUMANIZATION_TRICOLON_THRESHOLD}} → tricolon density cap (e.g., "2")
```

**Rule categories:**

| Category | Failure trigger |
|---|---|
| BannedVocabulary | Single occurrence of any banned word (word-boundary match) |
| HedgePhrases | Single occurrence of hedging constructions |
| NotJustBut | "not just X but Y" pattern |
| GenericOpeners | First-sentence generic patterns |
| EmDashes | Density exceeds threshold per 500 words |
| Tricolons | Three-part parallel constructions exceed threshold per 500 words |

Adding a word to `humanization-rules.ts` automatically injects it into the next
Claude call's system prompt via the placeholder substitution.

---

### `scripts/lib/scrape.ts` — Campaign Scraper

Scrapes `invest.honeycombcredit.com`. Extracts campaign data from the `__NEXT_DATA__`
JSON blob embedded in the page HTML.

```typescript
async function fetchCampaign(slug: string): Promise<FetchedCampaign>
// { campaign: Campaign, pageProps: unknown, html: string }

async function listListing(): Promise<ListingEntry[]>
// Fetches homepage; returns ~10 active Fundraising campaigns

function extractHeroImageUrl(
  campaign: Campaign, pageProps: unknown, html: string
): string | null
// Priority chain (most stable → least stable):
//   1. pageProps.ogImageUrl  — canonical Honeycomb OG field
//   2. campaign.ogImageUrl   — inner campaign field
//   3. Top-level alternates  — heroImageUrl, coverImageUrl, etc.
//   4. campaign.campaignMedia[] — newer campaign location
//   5. Deep-scan pageProps   — catch-all for unknown sibling shapes
//   6. HTML <img> regex      — last resort

function isCampaignSuccessful(stage: string): boolean
// Accepted values: 'Funded', 'Successful - Finalizing'

function campaignUrl(slug: string): string
// Returns https://invest.honeycombcredit.com/campaigns/{slug}

function extractNextData(html: string): unknown
// Regex-extract + JSON.parse the __NEXT_DATA__ script tag
```

---

### `scripts/lib/posthog.ts` — PostHog HogQL Client

Queries the Fivetran-mirrored `postgres.campaigns` table for funded campaigns.

```typescript
async function fetchFundedCampaigns(): Promise<FundedCandidate[]>
// Returns { slug, campaignName, campaignStage, fundedAt }[]
// WHERE stage IN ('Funded', 'Successful - Finalizing')
//   AND campaignExpirationDate >= '2026-01-01'
// ORDER BY expirationDate DESC (newest first)
```

**Environment variables:**
- `POSTHOG_API_KEY` — personal API key with `project:query:read` scope
- `POSTHOG_PROJECT_ID` — numeric project ID (Honeycomb Credit Production = `39093`)

---

### `scripts/lib/ratelimit.ts` — Rate-Limit Ledger

UTC daily counter. State file: `.state/ratelimit.json` (`{ "date": "YYYY-MM-DD", "used": N }`).
Counter resets at UTC midnight. File is written per run but **not committed to the repo**.

```typescript
const DEFAULT_CAP = 1;        // per UTC day, across all triggers
const HARD_MAX_OVERRIDE = 10; // maximum backfill override

async function canConsume(capOverride?: number): Promise<boolean>
async function consume(capOverride?: number): Promise<void>
async function status(capOverride?: number): Promise<{ used: number, remaining: number, cap: number }>
class RateLimitExceeded extends Error
```

---

### `scripts/lib/mdx.ts` — MDX File I/O

```typescript
async function writeCaseStudy(opts: {
  slug: string,
  frontmatter: object,
  body: string   // HTML; pasted directly into MDX body
}): Promise<{ path: string }>

async function readCaseStudy(slug: string): Promise<{ frontmatter: unknown, body: string } | null>
async function deleteCaseStudy(slug: string): Promise<boolean>

async function findByCampaignSlug(campaignSlug: string): Promise<{ slug: string, campaignSlug: string } | null>
// Walks all MDX files; matches on frontmatter.campaignSlug.
// Used for idempotency: prevents publishing the same campaign twice even if the
// case-study slug differs (Claude chooses the slug, so it can drift on retry).

async function listAllCampaignSlugs(): Promise<Set<string>>
// Returns the set of frontmatter.campaignSlug values for all published files.
// detect.ts uses this to filter out already-published campaigns.

function caseStudyPath(slug: string): string
// Returns absolute path: src/content/case-studies/{slug}.mdx
```

---

### `scripts/lib/image.ts` — Image Fetcher

```typescript
async function fetchAndStoreHeroImage(opts: {
  ogImageUrl: string,
  slug: string
}): Promise<{ publicPath: string, bytes: number }>
// Fetches URL, detects MIME type, writes to public/og/{slug}.{ext}
// Returns root-relative path e.g. "/og/brothmonger-brooklyn-bone-broth.jpg"

async function removeHeroImage(slug: string): Promise<string[]>
// Deletes all extension variants of public/og/{slug}.* (jpg, jpeg, png, webp, etc.)
// Returns list of deleted paths
```

---

### `scripts/lib/github.ts` — GitHub API Wrappers

```typescript
async function createIssue(opts: { title: string, body: string, labels: string[] }): Promise<{ number: number, url: string }>
async function addComment(issueNumber: number, body: string): Promise<void>
async function addLabel(issueNumber: number, label: string): Promise<void>
async function removeLabel(issueNumber: number, label: string): Promise<void>
async function closeIssue(issueNumber: number, reason: string): Promise<void>
```

**Environment variables:** `GITHUB_TOKEN`, `GITHUB_REPOSITORY` (owner/repo format)

---

### `scripts/lib/git.ts` — Git Operations

```typescript
async function configureBotIdentity(): Promise<void>  // sets git user.name/email for CI
async function add(...paths: string[]): Promise<void>
async function commit(message: string): Promise<{ committed: boolean }>
async function push(branch: string): Promise<void>
async function rm(path: string): Promise<void>
async function commitSha(): Promise<string>
```

---

### `scripts/lib/log.ts` — Structured Logging

```typescript
function setTrackingIssue(issueNumber: number | null): void
async function stage(message: string, context?: object): Promise<void>
// Posts a comment to the tracking issue; echoes to console
function info(label: string, context?: object): void
function warn(label: string, context?: object): void
function error(label: string, context?: object): void
// Console only. info() is suppressed in CI when FUNDED_BOT_IDENTITY=1.
```

---

### `scripts/lib/format.ts` — Formatters

```typescript
function formatMoney(amount: number): string   // e.g., "$100,000"
function formatTimeToFund(startDate: string, endDate: string): string  // e.g., "21 days"
function todayISO(): string                    // YYYY-MM-DD
```

---

### `scripts/lib/args.ts` — CLI Argument Parser

```typescript
function parseArgs(argv: string[]): { values: Record<string, string>, flags: Set<string> }
function requirePositional(args: ReturnType<typeof parseArgs>, index: number, name: string): string
// Throws with a usage hint if the positional is missing
```

---

### `scripts/lib/parse-slugs.ts` — Backfill Input Parser

```typescript
function parseSlugs(input: string): string[]
// Parses newline-separated list of Honeycomb campaign slugs.
// Defends against code-fence drift (strips ```, blank lines, whitespace).
```

---

## CLI Entry Points

All CLIs read `ANTHROPIC_API_KEY` (for generation) and `GITHUB_TOKEN` + `GITHUB_REPOSITORY`
(for issue operations) from environment variables.

### `scripts/generate.ts`

```
Usage: npx tsx scripts/generate.ts <slug> [--issue=N] [--force]

1. findByCampaignSlug() — skip if already published (unless --force)
2. canConsume() — refuse if rate-limit exhausted
3. consume() — increment counter
4. runPipeline({ slug })
5. Label tracking issue: published | error | humanization-warning
```

### `scripts/detect.ts`

```
Usage: npx tsx scripts/detect.ts [--dry-run]

1. fetchFundedCampaigns() from PostHog
2. listAllCampaignSlugs() → filter out already-published
3. For each eligible (rate-limited):
   a. createIssue() — open tracking issue
   b. runPipeline({ slug })
   c. Label: published | error | humanization-warning
4. Append row to .state/detection-log.md
5. Create daily summary GitHub issue
6. (Non-dry-run) push commits; caller (detect.yml) dispatches deploy.yml
```

### `scripts/redraft.ts`

```
Usage: npx tsx scripts/redraft.ts <case-study-slug> [--feedback="..."] [--issue=N]

1. readCaseStudy(slug) → recover frontmatter.campaignSlug
2. consume() — counts against rate-limit
3. runPipeline({
     slug: campaignSlug,
     feedback,
     forcedOutputSlug: caseStudySlug  // preserves existing public URL
   })
```

### `scripts/delete.ts`

```
Usage: npx tsx scripts/delete.ts <slug> [--issue=N]

1. git rm src/content/case-studies/{slug}.mdx
2. removeHeroImage(slug)
3. git commit + push
4. closeIssue()

Free operation — does not consume rate-limit.
```

### `scripts/backfill.ts`

```
Usage: npx tsx scripts/backfill.ts --slugs="A\nB\nC" [--force] [--dry-run] [--rate=N] [--issue=N]

1. parseSlugs(input) — parse newline list
2. --dry-run: print cost estimate (estimateCostForGeneration × count), exit
3. For each slug:
   a. findByCampaignSlug() — skip if exists (unless --force)
   b. canConsume(rate) — check; rate ≤ HARD_MAX_OVERRIDE (10)
   c. consume(rate)
   d. runPipeline({ slug, skipFundedCheck: true })
4. On rate-limit hit: addLabel('queued'), exit (remaining slugs deferred to next day)
```

### `scripts/inspect.ts`

```
Usage: npx tsx scripts/inspect.ts <slug>

1. fetchCampaign(slug)
2. Print scrape payload as JSON
3. Validate against CampaignSchema
4. No Claude call. No commits. No cost.
```

### `scripts/status.ts`

```
Usage: npx tsx scripts/status.ts

Reads .state/ratelimit.json; prints { used, remaining, cap }.
```

### `scripts/cost-estimate.ts`

```
Usage: npx tsx scripts/cost-estimate.ts --slugs="..."

parseSlugs(input) → count × estimateCostForGeneration() → print total.
```

### `scripts/dispatch-comment.ts`

Called by `on-comment.yml`. Parses `/funded <command> <args>` comments, validates
that the commenter is a repo collaborator, then execs the appropriate CLI. Posts
result back to the issue as a comment.

### `scripts/dispatch-issue.ts`

Called by `on-issue.yml`. Reads the issue title prefix to identify route
(`backfill.yml` → `backfill.ts`, `redraft-with-feedback.yml` → `redraft.ts`).

---

## Content Schema

Defined in `src/content/config.ts`. Validated by Astro at build time.
A Zod validation failure fails the build and blocks deploy.

### Frontmatter fields

| Field | Type | Constraint | Source |
|---|---|---|---|
| `businessName` | string | min 1 | scrape: `campaign.campaignName` |
| `niche` | string | 2–80 chars | Claude |
| `industry` | enum | 12 INDUSTRIES values | Claude |
| `city` | string | min 1 | scrape: `issuer.city` |
| `state` | string | 2-letter `[A-Z]{2}` | scrape: `issuer.state` uppercased |
| `h1Heading` | string | min 20 chars | Claude |
| `heroSubhead` | string | min 20 chars | Claude |
| `storyHeading` | string | min 4 chars | Claude |
| `heroImage` | string | `/og/[slug].[ext]` | `image.ts` |
| `heroImageAlt` | string | 8–200 chars | Claude |
| `ogImage` | string? | `/og/[slug].[ext]` | `image.ts` (same as heroImage) |
| `quote` | string? | — | reserved for future founder Q&A |
| `quoteAttribution` | string? | — | reserved for future founder Q&A |
| `amountRaised` | int | ≥ 0 | scrape: `Math.round(totalFundsRaised)` |
| `amountRaisedFormatted` | string | — | `formatMoney(amountRaised)` |
| `investorCount` | int | ≥ 0 | scrape: `Math.round(numInvestors)` |
| `timeToFund` | string | min 1 | `formatTimeToFund(start, end)` |
| `metaTitle` | string | 40–70 chars | Claude |
| `metaDescription` | string | 120–180 chars | Claude |
| `ogTitle` | string | 30–80 chars | Claude |
| `ogDescription` | string | 60–160 chars | Claude |
| `canonicalOverride` | URL? | — | manual override only |
| `ctaText` | string | min 3 chars | Claude |
| `campaignUrl` | URL | — | `campaignUrl(campaign.slug)` |
| `campaignId` | string | min 1 | scrape: `campaign.campaignId` |
| `campaignSlug` | string | min 1 | scrape: `campaign.slug` (idempotency key) |
| `publishedDate` | date | ISO, coerced | `todayISO()` |
| `systemSchemaJson` | object/array | JSON-LD | Claude, parsed |

**Note:** `ctaUrl` was removed in v4.0.x. `Cta.astro` constructs the UTM-tagged
pre-qualify URL from a constant base + `campaignSlug` at render time.

**Note on integer rounding:** `amountRaised` and `investorCount` are rounded to
integers via `Math.round()` in `pipeline.ts`. Honeycomb's API can return floating-
point monetary values (e.g., `46841.50001525879` due to JSON float imprecision);
without rounding the build fails Astro's `.int()` validation.

### MDX body

The body of the `.mdx` file is the `story` HTML from Claude's response, pasted
directly. Allowed HTML tags: `p`, `h2`–`h6`, `a`, `strong`, `em`, `ul`, `li`,
`br`, `span`. No `div`, `img`, `table`, `script`, or other tags.

---

## Claude Prompt Contract

**File:** `prompts/case-study-prompt.md` (~1,000 lines)

Sent as Claude's `system` message. After `applyPromptSubstitutions()` resolves the
`{{HUMANIZATION_*}}` placeholders, the full text is cached for the process lifetime.

### Key prompt sections

| Section | Content |
|---|---|
| §1 Role | Staff content writer at Honeycomb Credit |
| §2 Target reader | Small-business owner considering crowdfunding their business |
| §3 Input schema | Fields from `InputPayload`; sent as JSON in the `user` message |
| §4 Output schema | 14 required keys; return ONLY JSON (no preamble, no markdown fencing) |
| §5 Voice rules | Disruptive, approachable, trustworthy; no press-release language; center the founder |
| §6 Narrative arc | 5 beats: Opening → Stakes → Why Honeycomb → The Raise & Community → What the Money Did |
| §7 Hero section | H1 teases tension or names what's unique; subhead paints a scene |
| §8 Industry tags | 12 controlled vocabulary values |
| §9 Schema.org | Two JSON-LD entities: LocalBusiness (or subtype) + Article |
| §10 Slug rules | 3–6 words, lowercase hyphenated, business name + location/niche |
| §11 HTML rules | Allowlist tags only |
| §12 Failure modes | Banned phrases, AI vocabulary, generic openers, em-dash cap, tricolon cap |
| §13 Grounding | Every fact must trace to the input payload; no invented details |
| §14 Self-check | 24-point pre-output checklist |

### Hard output constraints

- Return **only** JSON — no preamble, no markdown fencing, no commentary
- `h1Heading`: 6–14 words
- `heroSubhead`: 8–16 words
- `storyHeading`: 4–10 words
- `story`: 800–1,200 words, HTML with allowlist tags only
- `systemSchemaJson`: ≤ 8,000 characters serialized
- `industry`: one of the 12 INDUSTRIES values (exact match)
- **For funded-below-goal campaigns:** goal amount, gap, and minimum investment
  are forbidden in headings and meta fields

### User message format

```
INPUT PAYLOAD:

{ ...InputPayload as JSON... }
```

For redraft / retry paths, the user message ends with:

```
REVIEWER FEEDBACK ON A PRIOR DRAFT — apply these corrections without changing anything else:

{ ...feedback text... }
```

---

## GitHub Workflows

### `detect.yml` — Daily Detection

**Current status:** Cron paused as of 2026-06-09 per operator request.
`workflow_dispatch` (with optional `dry-run: true`) remains active.

**When active, two daily slots:**
- `47 4 * * *` — 04:47 UTC (00:47 EDT; low GitHub Actions contention)
- `23 11 * * *` — 11:23 UTC (07:23 EDT; mid-morning backup slot)

Two slots are necessary because GitHub Actions drops or delays scheduled triggers
under high load. The script is fully idempotent — `listAllCampaignSlugs()` filters
out already-published campaigns before any rate-limit is consumed, so running twice
costs nothing when the first slot fires cleanly.

**To resume:** uncomment the `schedule:` block in `.github/workflows/detect.yml`.

**Permissions required:** `contents: write`, `issues: write`, `actions: write`

**Secrets required:** `ANTHROPIC_API_KEY`, `POSTHOG_API_KEY`, `POSTHOG_PROJECT_ID`
(plus auto-provided `GITHUB_TOKEN`)

**Deploy trigger:** After pushing case-study commits, `detect.yml` explicitly calls
`gh workflow run deploy.yml --ref main`. This is necessary because GitHub blocks
downstream `push:` workflow triggers from `GITHUB_TOKEN` pushes (recursion safeguard).

---

### `deploy.yml` — Build and Deploy

Triggers on every push to `main` and on `workflow_dispatch`.

Steps:
1. `npm run typecheck` — `astro sync && tsc --noEmit`
2. `npm test` — Vitest 57-test suite
3. `npm run build` — `astro build` → `dist/`
4. Upload artifact to GitHub Pages

Concurrency group `pages` with `cancel-in-progress: false` prevents mid-deploy clobber.
Live within ~2 minutes.

---

### `on-comment.yml` — Slash-Command Dispatcher

Triggers on `issue_comment` events where the body starts with `/funded`.
Routes through `scripts/dispatch-comment.ts`.

**Commands:**

| Slash command | Script | Approximate cost |
|---|---|---|
| `/funded generate <slug>` | `generate.ts` | ~$0.45 |
| `/funded redraft <slug> [--feedback="..."]` | `redraft.ts` | ~$0.45 |
| `/funded delete <slug>` | `delete.ts` | $0 |
| `/funded status` | `status.ts` | $0 |
| `/funded inspect <slug>` | `inspect.ts` | $0 |
| `/funded cost-estimate --slugs="..."` | `cost-estimate.ts` | $0 |
| `/funded backfill --slugs="..." [--dry-run] [--rate=N]` | `backfill.ts` | ~$0.45 × count |

---

### `on-issue.yml` — Issue-Form Dispatcher

Triggers on `issues: opened` events. Routes through `scripts/dispatch-issue.ts`
based on issue title prefix (set by the issue template).

| Issue template | Routes to |
|---|---|
| `backfill.yml` | `backfill.ts` |
| `redraft-with-feedback.yml` | `redraft.ts` |

---

## Operator Interfaces

Three equivalent ways to trigger agent actions. All produce GitHub Issue audit records
and call the same `scripts/` CLI code.

### 1. Operator portal (`/admin`)

Static Astro page at `https://funded.honeycombcredit.com/admin`. No backend.
Uses a browser-stored GitHub Personal Access Token (PAT) to open issues and post
comments via the GitHub API. Send this URL to operators instead of the repo README.

Full operator documentation (quickstart, sharing access, costs, troubleshooting)
is in the portal itself under the "⚠ Read me first" collapse block.

### 2. Slash commands

Post `/funded <command> <args>` in any issue or PR comment. Only repo collaborators
can trigger generation (commenter access is validated in `dispatch-comment.ts`).

### 3. Issue forms

GitHub → Issues → New Issue. Two templates:
- **Backfill case studies** — for batch runs of historical campaigns
- **Redraft with feedback** — structured form for a single case study with editor notes

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes (generation) | — | Claude API key |
| `GITHUB_TOKEN` | Auto in CI | — | GitHub API access for issue ops |
| `GITHUB_REPOSITORY` | Auto in CI | — | `owner/repo` format |
| `POSTHOG_API_KEY` | Yes (detect) | — | PostHog personal API key (`project:query:read`) |
| `POSTHOG_PROJECT_ID` | Yes (detect) | — | Numeric project ID (`39093` = Honeycomb Credit Production) |
| `CASE_STUDY_MODEL` | No | `claude-opus-4-7` | Claude model override for A/B testing |
| `FUNDED_BOT_IDENTITY` | `'1'` in CI | — | Suppresses `info()` console output in Actions logs |

Copy `.env.example` to `.env` for local development.

---

## Development Setup

```bash
nvm use            # Node 20+ (reads .nvmrc)
npm install

npm run dev        # Astro dev server at http://localhost:4321
npm run build      # Static output to dist/
npm run preview    # Preview dist/ locally
npm run typecheck  # astro sync && tsc --noEmit
npm test           # vitest run (57 tests)
npm run test:watch # vitest watch mode

# Agent CLIs (add ANTHROPIC_API_KEY + GITHUB_TOKEN to .env first)
npx tsx scripts/inspect.ts <slug>                          # free diagnostic
npx tsx scripts/generate.ts <slug>                        # ~$0.45
npx tsx scripts/redraft.ts <slug> --feedback="..."        # ~$0.45
npx tsx scripts/delete.ts <slug>                          # free
npx tsx scripts/backfill.ts --slugs="A\nB\nC" --dry-run  # free estimate
npx tsx scripts/backfill.ts --slugs="A\nB\nC"            # ~$0.45 × count
npx tsx scripts/detect.ts --dry-run                       # free scan
npx tsx scripts/detect.ts                                 # cron entry point
```

---

## Testing

57 unit tests in Vitest, co-located with source in `scripts/lib/`:

| Test file | What it covers |
|---|---|
| `format.test.ts` | `formatMoney`, `formatTimeToFund`, `todayISO` edge cases |
| `humanize.test.ts` | Humanization validator — each rule category, density thresholds |
| `scrape.test.ts` | `__NEXT_DATA__` extraction; `CampaignSchema` validation |
| `posthog.test.ts` | HogQL request shape |
| `parse-slugs.test.ts` | Slug parser — code-fence drift, blank lines, edge cases |

All 57 tests run on every deploy (`deploy.yml`). A failing test blocks the build.

---

## Cost Model

| Operation | Cost |
|---|---|
| Generate or redraft (1 attempt) | ~$0.45 (Opus 4.7, ~17K input + ~2.7K output tokens) |
| Humanization retry (2nd Claude call) | Additional ~$0.45 |
| Inspect / delete / status / cost-estimate | $0 |
| Astro build + Pages deploy | $0 (GitHub Actions free tier) |
| Steady state (~10 funded campaigns/month) | ~$5/month |

Rate limit: **1/day** (default) or up to **10/day** (backfill override).
Counter resets at UTC midnight.

---

## Three-Layer Validation System

| Schema | File | Gates | Failure behavior |
|---|---|---|---|
| Content collection | `src/content/config.ts` | MDX frontmatter at build time | Astro build fails; deploy blocked |
| Claude output | `scripts/lib/schemas.ts ClaudeOutputSchema` | 14-key JSON response | Generation fails; tracking issue gets `error` label |
| Scrape payload | `scripts/lib/schemas.ts CampaignSchema` | `__NEXT_DATA__` from Honeycomb | Scrape fails; tracking issue gets `error` label |

When Honeycomb changes their Next.js page structure, the third schema is the
first thing to break — its explicit field-presence checks surface the change
before it can corrupt an MDX file.

---

## Known Gaps

1. **Founder-level input data.** The `InputPayload` has no founder name, photo, or
   verbatim Q&A. The "Ask The Founders" tab on each campaign page would unlock this
   and is the single biggest content-quality lever on the roadmap. See
   `prompts/case-study-prompt.md §6` for the current compensating strategies.

2. **Rate-limit persistence is per-run, not per-day.** `consume()` writes
   `.state/ratelimit.json` but `pipeline.ts` does not commit it, so each new workflow
   invocation starts with a fresh `used: 0` counter. The cron runs once or twice per
   day and backfill self-caps at `HARD_MAX_OVERRIDE`, so this has not caused overspend
   in practice. Fix: commit `.state/ratelimit.json` inside `pipeline.ts` after each
   `consume()` call, then reason carefully about race conditions when two workflows
   overlap.

3. **Pre-2026 historical campaigns are not auto-detected.** The PostHog HogQL query
   floors at `campaignExpirationDate >= '2026-01-01'`. ~570 earlier funded campaigns
   exist in the database and are intentionally excluded from the cron. Publish them
   manually via the Backfill Issue Form.

4. **Daily cron is currently paused.** As of 2026-06-09, both cron slots in
   `detect.yml` are commented out to stop Anthropic API spend. To resume: uncomment
   the `schedule:` block in `.github/workflows/detect.yml`.

---

## Deployment

Every push to `main` triggers `deploy.yml`. The Astro build reads all `.mdx` files
in `src/content/case-studies/`, validates each frontmatter object against the Zod
schema in `src/content/config.ts`, compiles the full site to `dist/`, and uploads
to GitHub Pages.

Custom domain `funded.honeycombcredit.com` is configured via:
1. `public/CNAME` — sets the domain for GitHub Pages
2. Repository Settings → Pages → Custom domain

`detect.yml` pushes new case-study commits using the auto-provided `GITHUB_TOKEN`.
Because GitHub blocks downstream `push:` triggers from `GITHUB_TOKEN` pushes,
`detect.yml` must explicitly dispatch `deploy.yml` via
`gh workflow run deploy.yml --ref main` after each content push.
