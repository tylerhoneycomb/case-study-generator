# CLAUDE.md — Collateral Development Agent

> **Purpose of this file:** Authoritative spec for the Collateral Development Agent
> (funded.honeycombcredit.com). It is written to be self-sufficient: given only this
> file, an AI coding assistant should be able to understand the full system and recreate
> it from scratch.

---

## What this system is

A static website at **funded.honeycombcredit.com** that publishes a case study for every
Honeycomb Credit campaign that successfully raises its funding goal. The **repo itself is
the agent** — GitHub Actions runs the detection cron, operators drive ad-hoc actions
through GitHub Issues and a web portal, and the case studies live as MDX files in this
repo.

**The product goal:** Give small-business owners considering Honeycomb Credit a proof-of-
concept library — real local businesses, real raises, real outcomes. Every page is a
case study whose target reader is a prospective issuer, not an investor.

---

## Architecture overview

```
PostHog (Fivetran mirror of postgres.campaigns)
    │
    │  HogQL query — "which slugs are Funded and not yet published?"
    ▼
detect.ts          (cron entry point — runs in GitHub Actions twice daily)
    │
    │  per-slug loop
    ▼
pipeline.ts        (shared per-slug orchestration — scrape → Claude → validate → commit)
    ├── scrape.ts         fetch invest.honeycombcredit.com/__NEXT_DATA__ + hero image
    ├── claude.ts         call Claude Opus with case-study-prompt.md + InputPayload
    ├── humanize.ts       AI-tells regex validator (banned vocab, density caps, openers)
    ├── image.ts          download + store hero image under public/og/
    └── mdx.ts            write MDX frontmatter + body to src/content/case-studies/
    │
    ▼
git commit + push to main
    │
    ▼
deploy.yml         Astro build (typecheck + 65-test suite + astro build) → GitHub Pages
```

The same pipeline is also reachable via:
- **Operator portal** — https://funded.honeycombcredit.com/admin (browser forms, PAT auth, no backend)
- **Slash commands** — `/funded <command> <slug>` in any GitHub issue/PR comment (OWNER / COLLABORATOR / MEMBER only)
- **Issue Forms** — `[Backfill]` or `[Redraft]` prefixed issues routed by on-issue.yml

---

## Repository layout

```
src/
  content/
    case-studies/     ← one .mdx per funded campaign (agent writes here)
    config.ts         ← Zod content-collection schema; single source of truth for MDX frontmatter
  pages/
    [...slug].astro   ← dynamic case-study renderer
    index.astro       ← directory listing page
    admin/index.astro ← operator portal (noindex, excluded from sitemap)
    rss.xml.js        ← /rss.xml feed
  layouts/
    CaseStudy.astro   ← hero + metrics strip + body + CTA
  components/
    BaseHead.astro    ← <head> tag with SEO fields from frontmatter
    Hero.astro        ← full-bleed hero image + h1 + subhead
    MetricsStrip.astro ← raised / goal / investors / time-to-fund badges
    Quote.astro       ← optional founder pull-quote
    Cta.astro         ← pre-qualify CTA (UTM-tagged, constructed from campaignSlug)
    JsonLd.astro      ← injects systemSchemaJson into <script type="application/ld+json">
    SiteHeader.astro
    SiteFooter.astro

public/
  og/               ← hero / OG images, one per case study (downloaded by image.ts)
  CNAME             ← funded.honeycombcredit.com

scripts/
  detect.ts         ← cron entry point (PostHog query → per-slug loop with rate limiting)
  generate.ts       ← one-off generation for a single slug
  redraft.ts        ← regenerate with reviewer feedback (overwrites existing file)
  delete.ts         ← delete case study MDX + hero image
  backfill.ts       ← bulk historical publish (rate override up to 10/day)
  inspect.ts        ← diagnostic scrape dump, no API spend
  status.ts         ← print publication status for a slug
  cost-estimate.ts  ← print estimated cost for a list of slugs
  dispatch-comment.ts ← internal: route /funded slash commands (called by on-comment.yml)
  dispatch-issue.ts   ← internal: route Issue Form submissions (called by on-issue.yml)
  lib/
    posthog.ts      ← HogQL client; returns FundedCandidate[] for funded slugs
    scrape.ts       ← __NEXT_DATA__ extraction + hero-image fallback chain
    claude.ts       ← Anthropic SDK wrapper; loads prompt, sends InputPayload, validates output
    humanize.ts     ← AI-tells regex validator (port of velo_humanization.jsw)
    humanization-rules.ts ← single source of truth for all banned phrases / thresholds
    ratelimit.ts    ← 1/day default cap, 10/day backfill override, UTC-midnight reset
    pipeline.ts     ← shared per-slug pipeline (stages 1–6; see below)
    github.ts       ← Octokit wrappers (createIssue, addComment, addLabel, etc.)
    mdx.ts          ← MDX read / write, idempotency by campaignSlug
    git.ts          ← configureBotIdentity, add, commit, commitSha
    parse-slugs.ts  ← Backfill input parser (strips code-fence drift)
    image.ts        ← fetchAndStoreHeroImage (download + write to public/og/)
    format.ts       ← formatMoney, formatPercent, formatTimeToFund, todayISO
    schemas.ts      ← Zod schemas: ClaudeOutputSchema, CampaignSchema, ListingEntrySchema
    args.ts         ← CLI argument helpers
    log.ts          ← stage(), info(), warn() — output consumed by GitHub Actions logs

prompts/
  case-study-prompt.md  ← runtime system prompt sent to Claude on every generation

.github/
  workflows/
    deploy.yml          ← Astro build + Pages deploy on every push to main
    detect.yml          ← dual daily cron (04:47 UTC + 11:23 UTC); calls detect.ts
    on-comment.yml      ← /funded slash dispatcher; auth: OWNER/COLLABORATOR/MEMBER
    on-issue.yml        ← Issue Form dispatcher; routes by [Backfill] / [Redraft] title prefix
  ISSUE_TEMPLATE/
    backfill.yml               ← Issue Form for bulk backfill
    redraft-with-feedback.yml  ← Issue Form for reviewer-guided redraft
    config.yml                 ← disables blank issues; routes to the two forms

.state/
  detection-log.md    ← daily cron heartbeat (one row per run, committed by detect.yml)
  ratelimit.json      ← today's generation counter (written per run, not committed)

.env.example          ← all required + optional env vars with documentation
.nvmrc                ← Node 20+
astro.config.mjs      ← site URL, integrations (MDX, sitemap, tailwind), trailing-slash policy
tailwind.config.mjs   ← Honeycomb brand palette + Raleway/Open Sans fonts
tsconfig.json         ← strict: true, noUncheckedIndexedAccess: true, noImplicitOverride: true
vitest.config.mts     ← test runner; scans scripts/**/*.test.ts
```

---

## Content pipeline — stage by stage

`pipeline.ts / runPipeline(opts: RunOptions)` is the shared orchestration function called
by generate.ts, redraft.ts, and backfill.ts. All three differ only in their argument
source and pre-conditions.

### Stage 1 — Scrape

`scrape.ts / fetchCampaign(slug)` fetches `invest.honeycombcredit.com/campaigns/<slug>`,
extracts the `__NEXT_DATA__` JSON blob, and validates it against `CampaignSchema` (Zod).
Fields not in the schema are passed through (`.passthrough()`).

Hero image extraction (`extractHeroImageUrl`) tries six sources in order of stability:
1. `pageProps.ogImageUrl` (canonical Honeycomb OG field)
2. `campaign.ogImageUrl` (v3.3 inner field)
3. Top-level alternates: `heroImageUrl`, `coverImageUrl`, etc.
4. `campaignMedia[]` array
5. Deep scan of `pageProps` for any `honeycomb-uploads` URL
6. HTML `<img>` tag regex (last resort)

If the campaign is not in a successful stage (`Funded` or `Successful - Finalizing`) and
`skipFundedCheck` is false, the pipeline throws a `PipelineError` at this stage.

### Stage 2 — Generate (Claude)

`claude.ts / generateCaseStudy(payload: InputPayload)` builds a user message from the
campaign payload (see **InputPayload** below) and sends it to Claude with
`prompts/case-study-prompt.md` as the system prompt.

The prompt is loaded once per process and has its `{{HUMANIZATION_*}}` placeholders
substituted from `humanization-rules.ts` before use. This means adding a banned word
to `humanization-rules.ts` automatically updates both the validator and the prompt.

Model: `claude-opus-4-7` by default (override via `CASE_STUDY_MODEL` env var).
Max output tokens: 4096.

The response must be valid JSON matching `ClaudeOutputSchema` (14 required keys).
If JSON parsing fails or schema validation fails, a `ClaudeError` is thrown and the
tracking issue gets an `error` label.

### Stage 3 — Humanization validation

`humanize.ts / validateCopy(plain: string)` runs six regex-based checks on the
plain-text story body:

| Check | What it catches |
|---|---|
| `not_just_but` | "not just/only/merely/simply X but Y" constructions |
| `hedge_phrase` | Filler phrases ("it's worth noting", "at the end of the day", etc.) |
| `ai_vocab` | AI-overused vocabulary ("delve", "tapestry", "groundbreaking", etc.) |
| `generic_opener` | Clichéd story openers ("In today's world…", "Imagine a…", etc.) |
| `tricolon_list` | >2 three-item parallel lists per 500 words |
| `em_dash_overuse` | >3 em-dashes per 500 words |

All thresholds and banned-phrase lists live in `humanization-rules.ts`. Both the
validator and the Claude prompt read from the same source.

**Retry policy:** If validation fails, the pipeline retries once with the validator's
flagged issues spliced into `redraftFeedback`. If the retry also fails, the pipeline
publishes anyway and returns `humanizationWarnings` in the `RunResult`. Callers
(detect.ts, generate.ts) apply a `humanization-warning` label on the tracking issue.

The prompt (§13.5) presents the validator as a hard gate — intentionally, so the model
is motivated to comply — but the system-level fallback is publish-on-second-failure to
avoid leaving funded campaigns with no case study.

### Stage 4 — Hero image

`image.ts / fetchAndStoreHeroImage({ogImageUrl, slug})` downloads the hero image and
writes it to `public/og/<slug>.<ext>`. The file format is preserved from the source URL.
The public path (`/og/<slug>.<ext>`) is used as both `heroImage` and `ogImage` in the
MDX frontmatter.

### Stage 5 — Write MDX

`mdx.ts / writeCaseStudy({slug, frontmatter, body})` serializes the frontmatter as YAML
and writes a `.mdx` file to `src/content/case-studies/<slug>.mdx`. The function is
idempotent by `campaignSlug` — a second call for the same campaign overwrites the file.

All numeric monetary fields are rounded to integers before writing. Honeycomb's API can
return floating-point values (e.g., `46841.5`) that fail Astro's `.int()` validation.

### Stage 6 — Commit

`git.ts` configures the bot identity, stages the MDX file and hero image, and creates a
commit: `feat(case-study): publish <campaignName> (<slug>)`. The commit SHA is returned
in the `RunResult` for logging.

---

## InputPayload — what the agent sends to Claude

```typescript
interface InputPayload {
  campaignName: string;
  campaignSlug: string;
  campaignId: string;
  todayISO: string;         // YYYY-MM-DD (today's date)
  city: string;
  state: string;            // two-letter uppercase abbreviation
  totalFundsRaised: number;
  campaignTargetAmount: number;
  numInvestors: number;
  campaignStartDate: string;
  campaignExpirationDate: string;
  summary: string;          // HTML from campaign page
  useOfProceeds?: string;
  issuerWebsite?: string;
  issuerDescription?: string;
  ogImageUrl?: string;      // signal only; not used to fetch the image
  redraftFeedback?: string; // humanization validator issues or reviewer notes
}
```

---

## ClaudeOutputSchema — what Claude must return

14 required JSON keys (validated by Zod before any downstream processing):

| Key | Type | Constraints |
|---|---|---|
| `h1Heading` | string | ≥20 chars |
| `heroSubhead` | string | ≥20 chars |
| `storyHeading` | string | ≥4 chars |
| `story` | string | ≥2000 chars (rich-text HTML; 800–1200 words per prompt) |
| `heroImageAlt` | string | 8–200 chars |
| `metaTitle` | string | 40–70 chars |
| `metaDescription` | string | 120–180 chars |
| `ogTitle` | string | 30–80 chars |
| `ogDescription` | string | 60–160 chars |
| `ctaText` | string | ≥3 words |
| `slug` | string | lowercase kebab-case (`/^[a-z0-9-]+$/`) |
| `niche` | string | 2–80 chars |
| `industry` | enum | see controlled vocabulary below |
| `systemSchemaJson` | string \| object \| array | valid JSON-LD; ≤8000 chars serialized |

**Industry controlled vocabulary** (additive only — deprecate rather than remove):
Food & Beverage, Retail, Health & Wellness, Personal Services, Professional Services,
Arts & Entertainment, Manufacturing & Craft, Agriculture, Hospitality, Technology,
Education, Other

---

## MDX frontmatter schema — src/content/config.ts

Astro validates every `.mdx` file against this Zod schema at build time. Build failure =
deploy blocked.

The frontmatter is a superset of ClaudeOutputSchema plus campaign metrics and source
traceability fields:

- **Identity:** `businessName`, `niche`, `industry`, `city`, `state`
- **Headings:** `h1Heading`, `heroSubhead`, `storyHeading`
- **Images:** `heroImage` (regex `/og/[a-z0-9-]+\.(jpg|jpeg|png|webp|svg)$`), `heroImageAlt`, `ogImage` (optional, same pattern)
- **Quote:** `quote`, `quoteAttribution` (both optional)
- **Metrics:** `amountRaised` (int ≥0), `amountRaisedFormatted`, `goalAmount` (int >0), `goalAmountFormatted`, `percentOfGoal`, `percentOfGoalFormatted`, `investorCount`, `timeToFund`
- **SEO:** `metaTitle` (40–70), `metaDescription` (120–180), `ogTitle` (30–80), `ogDescription` (60–160), `canonicalOverride` (optional URL)
- **CTA:** `ctaText` (≥3 words) — no `ctaUrl`; `Cta.astro` constructs it from a constant base + `campaignSlug`
- **Traceability:** `campaignUrl`, `campaignId`, `campaignSlug`
- **Date:** `publishedDate` (coerced to Date)
- **JSON-LD:** `systemSchemaJson` (object or array; lenient shape; structural validation in `claude.ts`)

---

## GitHub Actions workflows

### deploy.yml

Triggered by: push to `main`, manual dispatch.

Steps: `npm ci` → typecheck (`astro sync && tsc --noEmit`) → test (`vitest run`, 65 tests)
→ `astro build` → upload artifact → deploy to GitHub Pages.

Concurrency group `pages`, `cancel-in-progress: false` (no mid-deploy cancellations).

Custom domain: `funded.honeycombcredit.com` via `public/CNAME` + Pages settings.

### detect.yml

Triggered by: cron at `47 4 * * *` (04:47 UTC / 00:47 EDT) **and** `23 11 * * *`
(11:23 UTC / 07:23 EDT), plus manual dispatch with optional `dry-run` flag.

Two slots exist because GitHub Actions silently drops or delays scheduled workflows
during high-load periods; the script is idempotent so two runs on the same day cost
nothing when both land.

Permissions: `contents: write`, `issues: write`, `actions: write`.

Steps:
1. Checkout with `fetch-depth: 0` + `GITHUB_TOKEN`
2. `npm ci`
3. Run `npx tsx scripts/detect.ts` (or `--dry-run`)
4. `git push origin HEAD:main` (captured; sets `pushed` output)
5. `gh workflow run deploy.yml --ref main` (only if `pushed == 'true'` and not dry-run)

Note: GITHUB_TOKEN pushes don't trigger downstream `push:` workflows (GitHub recursion
guard). The explicit `gh workflow run` dispatch in step 5 is how the deploy fires.

Required secrets: `ANTHROPIC_API_KEY`, `POSTHOG_API_KEY`, `POSTHOG_PROJECT_ID`.

### on-comment.yml

Triggered by: issue comment created.

Auth gate: `author_association` must be `OWNER`, `COLLABORATOR`, or `MEMBER`. Non-
collaborator comments are silently ignored.

Command format: `/funded <command> <slug>` (must start with `/funded `).

Supported commands (routed by `dispatch-comment.ts`):
- `generate <slug>` — run full pipeline (consumes rate-limit token)
- `redraft <slug> [--feedback="..."]` — regenerate with optional feedback
- `delete <slug>` — delete MDX + hero image
- `status <slug>` — print publication status
- `cost-estimate <slug>` — print estimated API cost
- `inspect <slug>` — diagnostic scrape dump

The workflow reacts to the comment with a 👀 emoji before running, then pushes + deploys
if content changed.

### on-issue.yml

Triggered by: issue opened, edited, or labeled.

Routing: title prefix `[Backfill]` → `backfill.ts`; `[Redraft]` → `redraft.ts`.
(Title prefixes come from Issue Form templates and cannot be dropped by GitHub.)

Anti-replay: `dispatched` label is added after the workflow completes; subsequent
edit/label events skip the workflow via `!contains(labels, 'dispatched')`.

Concurrency: serialized per issue number to prevent race conditions between near-
simultaneous trigger types (e.g., opened + labeled within milliseconds).

No `author_association` check — anyone who can open a GitHub issue can submit an Issue
Form. The Issue Forms are the operator-facing high-throughput path; the assumption is
that issue access is limited to trusted collaborators by repo visibility settings.

---

## Rate limiting

`scripts/lib/ratelimit.ts` manages `.state/ratelimit.json`:

```json
{ "date": "2026-05-01", "used": 2 }
```

- **Default cap:** 1 generation per UTC day (across all triggers)
- **Backfill override:** up to 10/day (hard maximum regardless of `capOverride` argument)
- **Day boundary:** UTC midnight — `date` field mismatch triggers auto-reset
- **First run of day:** ENOENT → fresh state (0 used)

**Known limitation:** `ratelimit.json` is written during the workflow run but not
committed back to the repo. Each new GitHub Actions runner starts with a fresh checkout,
so each invocation reads `0 used` even if another ran earlier the same day. In practice
this hasn't caused over-spend (cron runs once or twice daily; backfill self-caps;
manual ops are infrequent), but the "1/day" semantic is not enforced across concurrent
workflow runs.

---

## Pricing and cost model

| Item | Cost |
|---|---|
| Generate or redraft (single attempt) | ~$0.46 (Opus 4.7: $15/Mtok input, $75/Mtok output; ~17K in + 2.7K out) |
| Two-attempt path (humanization retry) | ~$0.92 |
| Inspect / delete / status | $0 |
| Astro build + Pages deploy | $0 (GitHub Actions free tier) |
| Steady state (~10 campaigns/month) | ~$5/month |

Pricing constants in `claude.ts`:

```typescript
const PRICING = {
  'claude-opus-4-7':          { input: 15,  output: 75  },
  'claude-sonnet-4-6':        { input: 3,   output: 15  },
  'claude-haiku-4-5-20251001': { input: 1,  output: 5   },
};
```

---

## Case study prompt — prompts/case-study-prompt.md

1004-line runtime system prompt. Key sections:

- **§1 Role:** Staff content writer at Honeycomb Credit
- **§2 Target reader:** Small-business owner considering Honeycomb Credit for their own raise
- **§3 Input contract:** `InputPayload` JSON shape (mirrors the TypeScript type)
- **§4 Output contract:** 14 JSON keys (mirrors `ClaudeOutputSchema`)
- **§5 Voice rules:** Disruptive, approachable, trustworthy; plainly written; real names/places/numbers; founder as protagonist
- **§6 Narrative structure:** 5-beat arc — opening scene → business + stakes → why Honeycomb → raise details + community → what the money did
- **§7 Texture rules:** Specificity ladder, sentence rhythm, pull-quote density, inverted pyramid
- **§8 Formatting:** HTML output (not Markdown); approved tags only
- **§9 JSON-LD:** Two-entity array — one `LocalBusiness` subtype + one `Article`
- **§10 SEO / meta fields:** Character limits matching `ClaudeOutputSchema`
- **§11 CTA text:** Imperative, specific to the business
- **§12 Humanization rules:** 6 sections covering banned vocab, hedge phrases, openers, density caps — sourced at runtime from `humanization-rules.ts` via `{{HUMANIZATION_*}}` placeholder substitution
- **§13 Self-check checklist:** 24 items to verify before returning JSON
- **§14 Worked example:** Full Brothmonger case study demonstrating expected output shape

The `{{HUMANIZATION_*}}` placeholders are substituted by `applyPromptSubstitutions()`
in `claude.ts` before each API call. This means editing `humanization-rules.ts` is the
only change needed to update both the validator and the prompt.

---

## Astro site

- **Framework:** Astro 5 with MDX, sitemap, and Tailwind integrations
- **Site URL:** `https://funded.honeycombcredit.com`
- **Trailing slash:** never
- **Build format:** directory (`/slug/index.html`)
- **Sitemap:** excludes `/admin` (noindex; operator-only page)
- **Brand palette:** yellow `#FFDE17`, cream `#F6F3E5`, purple `#3F296B`, blue `#D9ECFF`, green `#59B16B`, ink `#222222`
- **Fonts:** Raleway (display headlines), Open Sans (subheadings and body)
- **RSS feed:** `/rss.xml` — all published case studies

The `[...slug].astro` page is the dynamic renderer. It reads the MDX content collection,
renders the `CaseStudy` layout, and injects JSON-LD via `JsonLd.astro`.

The `/admin` page (`admin/index.astro`) is the operator portal. It uses browser-stored
PAT authentication (no backend) and renders forms that call the GitHub REST API directly
to dispatch slash commands or issue operations.

---

## Development setup

```bash
nvm use                # Node 20+ (see .nvmrc)
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY and POSTHOG_* vars
npm run dev            # Astro dev server at http://localhost:4321
npm run build          # static output to dist/
npm run typecheck      # astro sync && tsc --noEmit
npm test               # vitest run (65 tests across 5 test files)
```

Running agent CLIs locally requires `ANTHROPIC_API_KEY` in `.env`. Detection additionally
requires `POSTHOG_API_KEY` and `POSTHOG_PROJECT_ID`. `GITHUB_TOKEN` is needed for any
script that creates or comments on issues.

```bash
npx tsx scripts/inspect.ts <slug>                          # diagnostic scrape dump; no API spend
npx tsx scripts/generate.ts <slug>                         # full pipeline; ~$0.46
npx tsx scripts/redraft.ts <slug> --feedback="..."         # regenerate with feedback
npx tsx scripts/delete.ts <slug>                           # delete MDX + hero image
npx tsx scripts/backfill.ts --slugs="slug-a\nslug-b" \     # bulk publish
  [--dry-run] [--force] [--rate=N]
npx tsx scripts/detect.ts [--dry-run]                      # the cron entry point
npx tsx scripts/status.ts <slug>                           # publication status
npx tsx scripts/cost-estimate.ts <slug>                    # estimated cost
```

---

## Testing

5 test files, 65 tests total (as of v4.0.0):

| File | What it tests |
|---|---|
| `scripts/lib/humanize.test.ts` | AI-tells validator (20 tests) |
| `scripts/lib/scrape.test.ts` | __NEXT_DATA__ extraction + hero-image fallback chain (18 tests) |
| `scripts/lib/posthog.test.ts` | HogQL client + row parsing + error handling (7 tests) |
| `scripts/lib/parse-slugs.test.ts` | Backfill slug parser (9 tests) |
| `scripts/lib/format.test.ts` | formatMoney / formatPercent / formatTimeToFund (11 tests) |

Tests run in node environment (no DOM). The deploy workflow runs `npm test` as a gate
before `astro build` — a failing test blocks the deploy.

---

## Three validation layers

| Layer | File | Validates | Failure mode |
|---|---|---|---|
| Build time | `src/content/config.ts` | MDX frontmatter (every `.mdx` in `case-studies/`) | Astro build fails → deploy blocked |
| Generation time | `scripts/lib/schemas.ts` `ClaudeOutputSchema` | Claude's 14-key JSON response | `ClaudeError` thrown → tracking issue gets `error` label |
| Generation time | `scripts/lib/schemas.ts` `CampaignSchema` | Honeycomb scrape payload | `PipelineError` thrown → tracking issue gets `error` label |

When Honeycomb's `__NEXT_DATA__` shape changes, `CampaignSchema` is what catches it —
all fields beyond the minimum required set are `.optional()` and the schema uses
`.passthrough()` for unknown keys.

---

## Operational state

| File | What it tracks | Notes |
|---|---|---|
| `.state/detection-log.md` | One row per cron run: timestamp, PostHog-returned count, already-published, eligible, generated, rate-limit deferred, failed | Committed by detect.yml after every run (including dry-run) |
| `.state/ratelimit.json` | `{ date, used }` — today's generation counter | Written per run, not committed; resets on each fresh checkout |

---

## Required secrets (GitHub Actions → Settings → Secrets → Actions)

| Secret | Used by | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | detect.yml, on-comment.yml, on-issue.yml | Anthropic API key for Claude |
| `POSTHOG_API_KEY` | detect.yml | PostHog personal API key with `project:query:read` |
| `POSTHOG_PROJECT_ID` | detect.yml | Numeric PostHog project ID |
| `GITHUB_TOKEN` | All workflows | Auto-provided; needs `contents: write`, `issues: write`, `actions: write` |

---

## Known gaps and roadmap

**Founder-level input data** — The current scrape payload lacks the founder's name, photo,
and verbatim Q&A from the "Ask The Founders" tab. Adding these fields to `InputPayload`
would be the single highest-impact quality improvement. The prompt (§6) compensates
today by constructing a representative founder voice from campaign narrative text.

**Rate-limit persistence** — `.state/ratelimit.json` is written per run but not committed.
Each GitHub Actions runner starts with a fresh checkout and a fresh 0-count. The fix is
small (commit the file inside the per-slug commit in `pipeline.ts`), but requires
reasoning about race conditions when multiple workflow runs overlap.

**Pre-2026 campaigns** — The PostHog query floors at `campaignexpirationdate >= '2026-01-01'`.
~570 historical funded campaigns are visible but intentionally excluded from auto-
detection. They are published manually via the Backfill Issue Form on a case-by-case basis.

---

## Design decisions worth preserving

1. **Repo-as-agent pattern.** GitHub Actions is the runtime; the repo is both the state
   store (MDX files, `.state/`) and the interface surface (Issues, comments). No external
   databases, no separate service.

2. **Single shared pipeline.** `generate.ts`, `redraft.ts`, and `backfill.ts` all call
   `runPipeline()`. The only differences are argument source, rate-limit treatment, and
   `skipFundedCheck`. Adding a new entry point means wiring args → `RunOptions`, not
   duplicating pipeline logic.

3. **Humanization rules as single source of truth.** `humanization-rules.ts` drives both
   the validator regex set and the Claude system prompt. They cannot drift apart.

4. **Two-strikes-and-publish.** A hard humanization gate left real funded campaigns
   unpublished (#39, #41 in the issues). Soft-fail with a `humanization-warning` label
   bounds quality loss while guaranteeing every funded campaign gets a page.

5. **Build-time schema as the contract.** The Zod content-collection schema in
   `src/content/config.ts` is the canonical definition of what a case study is. The
   Astro build enforces it on every deploy. `ClaudeOutputSchema` in `scripts/lib/schemas.ts`
   mirrors the relevant subset — both must be kept in sync manually when fields change.

6. **No ctaUrl in frontmatter.** `Cta.astro` constructs the CTA link from a constant
   base URL + `campaignSlug`. This avoids stale UTM parameters and makes the CTA
   destination a single-file change rather than a per-case-study edit.
