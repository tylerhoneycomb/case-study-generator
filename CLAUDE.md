# funded.honeycombcredit.com — Technical Reference

## What this is

This repository is the **Collateral Development Agent** for Honeycomb Credit. It automatically publishes case studies for funded campaigns on the Honeycomb Credit investment platform, serving the public site at **https://funded.honeycombcredit.com**.

**The repo itself is the agent.** GitHub Actions runs discovery and generation; MDX files in `src/content/case-studies/` are the content; GitHub Pages serves the site. There is no backend or database — all state lives in the repo, GitHub Issues, and GitHub Pages.

### What it does
1. **Discovers** newly funded campaigns daily via PostHog (HogQL SQL over a Fivetran-mirrored `postgres.campaigns` table)
2. **Scrapes** campaign details from `invest.honeycombcredit.com` (Next.js `__NEXT_DATA__` extraction)
3. **Generates** a case study using Claude Opus 4.7 via a ~1,000-line structured prompt
4. **Validates** the output against a Zod schema and a humanization regex suite
5. **Publishes** MDX to the repo, which triggers an Astro build and GitHub Pages deploy
6. **Tracks** every action through GitHub Issues as a unified audit log

---

## Essential Commands

```bash
nvm use              # Node 20+ (see .nvmrc)
npm install
npm run dev          # http://localhost:4321
npm run build        # dist/ (static output)
npm run typecheck    # astro sync && tsc --noEmit
npm test             # vitest run (65 tests)
```

CLI scripts require `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` in the shell environment.

```bash
npx tsx scripts/inspect.ts <slug>                         # diagnostic; no spend, no commits
npx tsx scripts/generate.ts <slug>                        # ~$0.45 Anthropic spend
npx tsx scripts/redraft.ts <slug> --feedback="..."        # regenerate with new instructions
npx tsx scripts/delete.ts <slug>                          # remove MDX + image
npx tsx scripts/backfill.ts --slugs="A\nB\nC" [--force] [--dry-run] [--rate=N]
npx tsx scripts/detect.ts [--dry-run]                     # cron entry point
npx tsx scripts/status.ts                                 # rate-limit + published count
npx tsx scripts/cost-estimate.ts --slugs="..."            # token cost estimate
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Framework** | Astro 5 + TypeScript 5.7 |
| **TypeScript config** | strict, `noUncheckedIndexedAccess`, `noImplicitOverride` |
| **Styling** | Tailwind CSS 3.4 |
| **Content** | MDX (Astro integration) with Zod validation |
| **Hosting** | GitHub Pages from private repo (GitHub Pro) |
| **CI/CD** | GitHub Actions (4 workflows) |
| **AI model** | Claude Opus 4.7 (`claude-opus-4-7`) via Anthropic SDK v0.65 |
| **Data source** | PostHog HogQL (PostHog mirrors Honeycomb's postgres.campaigns via Fivetran) |
| **Scraping** | `invest.honeycombcredit.com` `__NEXT_DATA__` extraction + cheerio HTML fallback |
| **GitHub API** | Octokit v21 |
| **Testing** | Vitest 2.1, Node environment, 65 tests |
| **CLI runtime** | `tsx` (TypeScript execution without transpile step) |
| **Node version** | 20+ (see `.nvmrc`) |
| **Path alias** | `~/*` → `src/*` |

---

## Repository Structure

```
src/
  content/
    case-studies/         ← one .mdx per funded campaign (~28 files; agent-written)
    config.ts             ← Zod content collection schema; authoritative frontmatter spec

  pages/
    [...slug].astro       ← dynamic case-study route (Astro SSG)
    index.astro           ← directory listing
    admin/index.astro     ← operator portal (noindex, no backend, PAT auth in browser)
    rss.xml.js            ← /rss.xml

  layouts/
    CaseStudy.astro       ← case-study page template

  components/
    FloatingCta.astro     ← sticky purple top bar; reveal-on-scroll, dismissible
    Hero.astro            ← full-width hero: H1 + subhead + image
    MetricsStrip.astro    ← 3-tile grid: Raised / Investors / Time to fund
    Quote.astro           ← optional founder pull-quote block
    Cta.astro             ← static bottom "Get prequalified" CTA
    BaseHead.astro        ← <head>: meta, OG tags, canonical
    JsonLd.astro          ← Schema.org JSON-LD (LocalBusiness + Article)
    SiteHeader.astro
    SiteFooter.astro

  styles/                 ← Global CSS

scripts/
  generate.ts             ← single case-study generation (manual)
  redraft.ts              ← regenerate with feedback string
  delete.ts               ← remove MDX + hero image
  backfill.ts             ← bulk historical regeneration (rate-capped)
  detect.ts               ← cron entry point: discovery + per-slug pipeline
  inspect.ts              ← diagnostic snapshot; no spend, no writes
  status.ts               ← rate-limit state + published count
  cost-estimate.ts        ← token cost estimate for a slug list
  dispatch-comment.ts     ← /funded slash command handler (issue comments)
  dispatch-issue.ts       ← Issue Form dispatcher (backfill, redraft)

  lib/
    pipeline.ts           ← shared 6-stage per-slug pipeline; all write-paths converge here
    claude.ts             ← Anthropic SDK wrapper; loads prompt; validates ClaudeOutputSchema
    humanize.ts           ← post-generation AI-tell regex validator
    humanization-rules.ts ← single source of truth for rules; injected into both humanize.ts and the prompt
    scrape.ts             ← invest.honeycombcredit.com extraction
    image.ts              ← fetch hero image URL + store to public/og/
    mdx.ts                ← assemble frontmatter; write MDX; idempotency by campaignSlug
    posthog.ts            ← HogQL client for funded campaign discovery
    github.ts             ← Octokit wrappers (issue, comment, reaction, label)
    ratelimit.ts          ← per-UTC-day generation budget (1/day default, 10/day backfill)
    git.ts                ← git add/commit wrappers
    schemas.ts            ← Zod contracts: ClaudeOutputSchema + CampaignSchema
    log.ts                ← colored console output
    args.ts               ← CLI argument parsing
    format.ts             ← date/money formatting utilities
    parse-slugs.ts        ← backfill input parser (code-fence resilient)
    *.test.ts             ← 65 Vitest tests

.github/
  workflows/
    deploy.yml            ← Astro build + Pages deploy (push to main + workflow_dispatch)
    detect.yml            ← discovery cron (PAUSED since 2026-06-09; re-arm: uncomment schedule block)
    on-comment.yml        ← /funded slash dispatcher; fires on issue/PR comments by collaborators
    on-issue.yml          ← Issue Form dispatcher; routes by issue title prefix

  ISSUE_TEMPLATE/
    backfill.yml                 ← bulk historical generation form
    redraft-with-feedback.yml    ← single redraft with feedback form
    config.yml

prompts/
  case-study-prompt.md    ← runtime prompt sent to Claude on every generation (~1,000 lines)

.state/
  detection-log.md        ← cron audit trail (one row per run; appended by detect.yml)
  ratelimit.json          ← today's generation counter (written by ratelimit.ts; NOT committed to repo)

public/
  og/                     ← hero/OG images (one per case study; stored by image.ts)
  demo/
    floating-cta.html     ← design prototype for FloatingCta.astro (noindex)
  CNAME                   ← funded.honeycombcredit.com DNS pointer
```

---

## Configuration

### Required secrets (GitHub Actions)
- `ANTHROPIC_API_KEY` — Claude Opus 4.7 API key
- `GITHUB_TOKEN` — provided automatically by Actions; needs `issues:write`, `contents:write`, `pages:write`

### Local development
Copy `.env.example` and fill in:
```
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_TOKEN=github_pat_...   # fine-grained PAT: issues:write on tylerhoneycomb/case-study-generator
```

### Environment variable overrides
- `CASE_STUDY_MODEL` — override the Anthropic model (default: `claude-opus-4-7`)

### Astro config (astro.config.mjs)
- **Site:** `https://funded.honeycombcredit.com`
- **Output:** `static` with directory format (clean URLs, no `.html` extensions)
- **Integrations:** MDX, RSS (`@astrojs/rss`), Tailwind CSS
- **Sitemap:** auto-generated; excludes `/admin`

---

## Content Schema (`src/content/config.ts`)

Astro validates every `.mdx` file in `src/content/case-studies/` against this Zod schema at build time. A validation failure fails the build and blocks deploy.

### Frontmatter fields (28 total)

**Identity**

| Field | Type | Constraints |
|---|---|---|
| `businessName` | string | min 1 |
| `niche` | string | 2–80 chars; e.g. "specialty pickle producer" |
| `industry` | enum | see Controlled Vocabulary below |
| `city` | string | min 1 |
| `state` | string | 2-letter uppercase US abbreviation |

**Headings (agent-written)**

| Field | Type | Constraints |
|---|---|---|
| `h1Heading` | string | min 20 chars |
| `heroSubhead` | string | min 20 chars |
| `storyHeading` | string | min 4 chars |

**Hero / OG image**

| Field | Type | Constraints |
|---|---|---|
| `heroImage` | string | path regex: `/^\/og\/[a-z0-9-]+\.(jpg\|jpeg\|png\|webp\|svg)$/i` |
| `heroImageAlt` | string | 8–200 chars |
| `ogImage` | string (optional) | same path regex as heroImage |

**Optional founder quote** (hidden by layout when absent)

| Field | Type |
|---|---|
| `quote` | string (optional) |
| `quoteAttribution` | string (optional) |

**Metrics** (numeric fields drive math; `*Formatted` fields drive display)

| Field | Type | Constraints |
|---|---|---|
| `amountRaised` | number | integer, nonnegative |
| `amountRaisedFormatted` | string | e.g. "$125,000" |
| `investorCount` | number | integer, nonnegative |
| `timeToFund` | string | free-form; e.g. "21 days", "under a week" |

**SEO**

| Field | Type | Constraints |
|---|---|---|
| `metaTitle` | string | 40–70 chars |
| `metaDescription` | string | 120–180 chars |
| `ogTitle` | string | 30–80 chars |
| `ogDescription` | string | 60–160 chars |
| `canonicalOverride` | string URL (optional) | — |

**CTA**

| Field | Type | Constraints |
|---|---|---|
| `ctaText` | string | min 3 chars |

**Source traceability**

| Field | Type | Constraints |
|---|---|---|
| `campaignUrl` | string URL | — |
| `campaignId` | string | min 1 |
| `campaignSlug` | string | Honeycomb's slug; used for UTM tagging and idempotency |

**Dates**

| Field | Type | Notes |
|---|---|---|
| `publishedDate` | date | coerced from ISO string or Date |

**JSON-LD**

| Field | Type | Notes |
|---|---|---|
| `systemSchemaJson` | array or object | LocalBusiness + Article; structural validation in `claude.ts` |

### Controlled vocabulary — `industry` (additive-only; never rename or remove)

```
Food & Beverage | Retail | Health & Wellness | Personal Services
Professional Services | Arts & Entertainment | Manufacturing & Craft
Agriculture | Hospitality | Technology | Education | Other
```

This list is duplicated in `src/content/config.ts` and `scripts/lib/schemas.ts`. Keep both in sync.

---

## Claude Output Schema (`scripts/lib/schemas.ts → ClaudeOutputSchema`)

Claude must return a JSON object with exactly these 14 keys. Any missing or invalid key is a generation failure — the tracking issue receives an `error` label and the pipeline aborts.

| Key | Type | Constraints |
|---|---|---|
| `h1Heading` | string | min 20 chars |
| `heroSubhead` | string | min 20 chars |
| `storyHeading` | string | min 4 chars |
| `story` | string | Rich-text HTML body; min 2000 chars (target: 800–1200 words) |
| `heroImageAlt` | string | 8–200 chars |
| `metaTitle` | string | 40–70 chars |
| `metaDescription` | string | 120–180 chars |
| `ogTitle` | string | 30–80 chars |
| `ogDescription` | string | 60–160 chars |
| `ctaText` | string | min 3 chars |
| `slug` | string | lowercase kebab-case only |
| `niche` | string | 2–80 chars |
| `industry` | enum | from controlled vocabulary |
| `systemSchemaJson` | string \| array \| object | JSON-LD; accepts stringified JSON or parsed form |

The `story` field is not a frontmatter field — `mdx.ts` writes it as the MDX body content (after the frontmatter closing `---`).

---

## Generation Pipeline (`scripts/lib/pipeline.ts`)

All write-paths (`generate.ts`, `redraft.ts`, `backfill.ts`) converge on the same 6-stage pipeline:

### Stage 1 — Scrape
- Fetch `invest.honeycombcredit.com/campaigns/{slug}`
- Extract `__NEXT_DATA__` JSON blob; parse with `CampaignSchema` (defensive: all optional fields except identity)
- Fallback: cheerio HTML parsing for hero image URL if `__NEXT_DATA__` shape drifts
- `extractHeroImageUrl()` walks `ogImageUrl`, `campaignMedia[]`, and any `honeycomb-uploads` URL

### Stage 2 — Claude call
- Load `prompts/case-study-prompt.md` from disk (cached after first read)
- Apply `{{HUMANIZATION_*}}` template substitution from `humanization-rules.ts`
- Call `claude-opus-4-7` (or `CASE_STUDY_MODEL` override) with the assembled prompt
- Parse JSON response; validate against `ClaudeOutputSchema`
- Run `isValidJsonLd()` structural check on `systemSchemaJson`
- On redraft: append `--feedback` string to prompt

### Stage 3 — Humanization validation
- Run `humanize.ts` regex suite against `story` + `metaDescription`
- On failure: retry once with re-prompt
- If 2/2 attempts fail: publish anyway; tracking issue labeled `humanization-warning`
- Non-blocking by design — imperfect publication > no publication

### Stage 4 — Image fetch
- Download hero image from OG URL extracted in Stage 1
- Store to `public/og/{slug}.{ext}`
- Detect format from content-type or URL extension

### Stage 5 — MDX write
- Assemble frontmatter: Claude output keys + scrape payload + derived fields (`amountRaised`, `amountRaisedFormatted`, `publishedDate`, etc.)
- Idempotency check: abort if a file with matching `campaignSlug` frontmatter already exists (bypass with `--force`)
- Write `src/content/case-studies/{slug}.mdx` (frontmatter YAML + story HTML body)

### Stage 6 — Git commit
- `git add src/content/case-studies/{slug}.mdx public/og/{slug}.*`
- `git commit -m "feat(case-study): publish {businessName} ({slug})"`
- One commit per campaign for a clean, auditable history

Returns `RunResult: { cost, inputTokens, outputTokens, commitSha, attempts, warnings }`.

---

## Humanization Validator (`scripts/lib/humanize.ts`)

Post-generation quality gate. The rule set lives in `scripts/lib/humanization-rules.ts` and is the **single source of truth**: it is imported by `humanize.ts` (regex builder) and injected into the Claude prompt via `{{HUMANIZATION_*}}` template substitution in `claude.ts`. Changing rules in one place updates both.

### What it checks in `story` + `metaDescription`

| Check | Threshold |
|---|---|
| **Banned vocabulary** (13 terms) | Any occurrence fails: "delve", "groundbreaking", "harness the power", "it's no secret", "in the realm of", "unlock", "navigate", "leverage" (as verb), "cutting-edge", "robust", "innovative", "seamlessly", "game-changer" |
| **Hedge phrases** (9 patterns) | Any occurrence fails: "it's worth noting", "at the end of the day", "needless to say", "rest assured", "it goes without saying", "suffice it to say", "in today's [world/landscape]", "it's important to note", "in conclusion" |
| **"Not just X but Y" pivot** | Any occurrence fails |
| **Generic openers** | Sentences starting "In today's", "In recent years", "As a", etc. |
| **Em-dash density** | >3 per 500 words = fail |
| **Tricolon density** | >2 per 500 words = fail |

Returns `HumanizationIssue[]`. Non-zero → `humanization-warning` label on tracking issue; case study still publishes.

---

## Rate Limiting (`scripts/lib/ratelimit.ts`)

- **Default budget:** 1 generation per UTC day across all triggers (cron + manual + portal)
- **Backfill override:** up to 10/day (passed as `--rate=N` or `rate` field in issue form)
- **Counter:** stored in `.state/ratelimit.json`; reset at UTC midnight
- **Excess work:** tracking issue labeled `queued`; cron drains queued issues before scanning for new campaigns
- **Known gap:** `.state/ratelimit.json` is not committed by workflows, so each new workflow invocation starts with a fresh 0-of-1 budget (see Known Gaps)

---

## GitHub Actions Workflows

### `deploy.yml`
- **Trigger:** `push` to main, `workflow_dispatch`
- **Steps:** `npm ci` → `npm run typecheck` → `npm test` → `npm run build` → push `dist/` to Pages
- **Time to live:** ~2 minutes from commit to production

### `detect.yml` (PAUSED since 2026-06-09)
- **Status:** `schedule:` block commented out. Re-arm: uncomment the schedule lines in `.github/workflows/detect.yml`. One-off run: Actions → detect → Run workflow.
- **Intended schedule:** `cron('7 12 * * *')` — 12:07 UTC daily
- **Also available:** `workflow_dispatch`
- **Flow:** PostHog HogQL query for funded campaigns ≥ 2026-01-01 → filter already-published → per-slug pipeline → push commits → trigger `deploy.yml` via `workflow_dispatch`
- **Audit:** Appends one row to `.state/detection-log.md` per run

### `on-comment.yml`
- **Trigger:** `issue_comment` + `pull_request_review_comment`
- **Auth gate:** `author_association` must be `OWNER` or `COLLABORATOR`
- **Commands:** `/funded generate|redraft|delete|status|cost-estimate|inspect <slug>`
- **Protocol:** React with eyes emoji on receipt; result posted back to the same thread

### `on-issue.yml`
- **Trigger:** `issues: opened`
- **Routes by issue title prefix:**
  - `[Backfill]` → `dispatch-issue.ts backfill`
  - `[Redraft]` → `dispatch-issue.ts redraft`

### Note on push recursion
`GITHUB_TOKEN`-authored pushes do not trigger `push:` workflows (GitHub's recursion safeguard). The cron uses an explicit `workflow_dispatch` call to trigger `deploy.yml` after pushing content.

---

## Data Flow

```
PostHog HogQL
    │  funded campaigns with campaignExpirationDate >= '2026-01-01'
    ▼
scripts/detect.ts  (or generate.ts / backfill.ts / portal / slash command)
    │  slug
    ▼
scripts/lib/scrape.ts ← invest.honeycombcredit.com/__NEXT_DATA__
    │  CampaignSchema payload
    ▼
scripts/lib/claude.ts ← prompts/case-study-prompt.md + humanization-rules.ts
    │  ClaudeOutputSchema JSON (14 keys)
    ▼
scripts/lib/humanize.ts (regex validation; non-blocking)
    │  HumanizationIssue[]
    ▼
scripts/lib/image.ts → public/og/{slug}.{ext}
    │
    ▼
scripts/lib/mdx.ts → src/content/case-studies/{slug}.mdx
    │
    ▼
scripts/lib/git.ts → git commit
    │
    ▼
.github/workflows/deploy.yml → astro build → GitHub Pages
    │
    ▼
https://funded.honeycombcredit.com/{slug}
```

---

## Components

### `CaseStudy.astro` (layout)

Every case study page renders through this layout. The page structure is:

```
<FloatingCta />          ← sticky top CTA bar (renders hidden; reveals on scroll)
<SiteHeader />
<main>
  <Hero />               ← full-width hero + H1 + subhead + image
  <MetricsStrip />       ← 3-tile color-blocked metric grid
  <section>              ← slot: case study body (rich-text HTML from Claude)
  <Quote />              ← optional pull-quote (layout hides block when absent)
  <Cta />                ← static bottom "Get prequalified" section
  <footer>               ← industry · niche · published date
</main>
<SiteFooter />
```

### `FloatingCta.astro`

A sticky purple bar pinned to the top of the viewport on all case study pages.

- **Purpose:** Recruit prospective business owners; separately attributed from the bottom CTA
- **Behavior:** Ships hidden (`-translate-y-full`, `inert`, `aria-hidden="true"`). Slides into view once the reader scrolls past `revealAfter` pixels (default: 600, which clears a typical hero). Session-scoped dismissal via `sessionStorage` key `floating_cta_dismissed`.
- **Accessibility:** `inert` and `aria-hidden` are toggled in lockstep with visibility to prevent phantom tab stops and screen-reader announcements while off-screen. Focus is moved off the dismiss button before the bar goes inert.
- **UTM scheme:** `utm_source=case_study`, `utm_medium=website`, `utm_campaign=success_stories`, `utm_content={campaignSlug}`, `utm_term=floating_bar`
- **Props:**
  - `campaignSlug: string` (required) — becomes `utm_content`
  - `ctaText?: string` (default: "Get prequalified today!")
  - `message?: string` (default: "Could your business raise like this?")
  - `revealAfter?: number` (default: 600px)
- **Demo:** `public/demo/floating-cta.html` (noindex)

### `MetricsStrip.astro`

Three-tile color-blocked metric grid beneath the hero. Tiles: **Raised** (yellow accent) / **Investors** / **Time to fund**.

Progress-to-goal was removed as a headline figure (v4.1, 2026-06-09). The narrative in `story` addresses partial-funded outcomes in-text when it carries weight (see `prompts/case-study-prompt.md §6 Beat 4`).

**Props:** `amountRaisedFormatted`, `investorCount`, `timeToFund`

### `Cta.astro`

Static bottom-of-page CTA section. Builds the pre-qualify URL from the constant base `https://start.honeycomb.credit/` + UTM params. No `utm_term` — the absence is what distinguishes bottom-CTA clicks from floating-bar clicks in analytics.

### `Hero.astro`

Full-width hero: H1 (`h1Heading`), subhead (`heroSubhead`), hero image, and a summary strip with business name, amount raised, investor count, city, and state.

---

## Testing

65 Vitest tests (`scripts/lib/*.test.ts`, Node environment):

| File | Tests | Coverage |
|---|---|---|
| `humanize.test.ts` | 20 | Banned vocabulary, hedge phrases, em-dashes, tricolons |
| `scrape.test.ts` | 18 | `__NEXT_DATA__` extraction, image URL fallback chains |
| `format.test.ts` | 11 | Money formatting, date formatting |
| `parse-slugs.test.ts` | 9 | Backfill input parser, code-fence resilience |
| `posthog.test.ts` | 7 | HogQL query construction and mocking |

**Deploy gate:** `npm run typecheck` (astro sync + tsc --noEmit) + `npm test` must both pass before any deploy ships.

---

## Operational State (as of 2026-06-24)

| Item | Status |
|---|---|
| **Live site** | https://funded.honeycombcredit.com |
| **Case studies published** | 28 |
| **Daily cron** | PAUSED since 2026-06-09. Re-arm: uncomment `schedule:` in `.github/workflows/detect.yml`, or trigger one-off from Actions → detect → Run workflow. |
| **Rate limit** | 1/day default; 10/day with backfill override |
| **Operator portal** | https://funded.honeycombcredit.com/admin |
| **Audit log** | https://github.com/tylerhoneycomb/case-study-generator/issues |
| **Cron heartbeat log** | `.state/detection-log.md` |
| **Campaign discovery window** | `campaignExpirationDate >= '2026-01-01'` |

---

## Known Gaps

### 1. Rate-limit persistence is per-run, not per-day
`consume()` in `ratelimit.ts` writes `.state/ratelimit.json`, but none of the workflows commit that file back to the repo. Each new workflow invocation resets the counter to 0. In practice this hasn't caused over-spend (cron runs once daily; backfill caps itself; manual ops are infrequent), but the documented "1/day across all triggers" semantic is more permissive than intended.

**Fix path:** Add `.state/ratelimit.json` to the per-slug `git add` in `pipeline.ts`. Requires handling race conditions if multiple workflows run concurrently.

### 2. Founder-level input missing
The scrape payload includes campaign summary, use-of-proceeds, and metrics, but not the founder's name, photo, or verbatim Q&A from the "Ask The Founders" tab. This is the single largest quality lever still on the roadmap.

**Fix path:** Extend `scrape.ts` to fetch and parse the "Ask The Founders" section; add corresponding optional fields to `CampaignSchema` and the runtime prompt (see `prompts/case-study-prompt.md §6`).

### 3. Pre-2026 historical campaigns excluded from auto-discovery
The PostHog detection query floors at `campaignExpirationDate >= '2026-01-01'`. Approximately 570 historical funded campaigns are visible to PostHog but intentionally excluded from the cron.

**Workaround:** Use the Backfill Issue Form for hand-picked historical publications.

---

## Design Invariants

These properties must be preserved when making changes:

1. **Single source of truth for humanization rules.** `scripts/lib/humanization-rules.ts` is imported by both `humanize.ts` (regex builder) and `claude.ts` (prompt template injection). Change rules in one file; both the validator and the prompt update automatically.

2. **Three-layer Zod validation.** Each layer gates a different boundary with a distinct failure mode:
   - `src/content/config.ts` — build-time frontmatter → fails the Astro build
   - `scripts/lib/schemas.ts ClaudeOutputSchema` — generation-time → fails the pipeline with `error` label
   - `scripts/lib/schemas.ts CampaignSchema` — scrape-time → fails the scrape with `error` label

3. **Idempotency by `campaignSlug`.** `mdx.ts` scans existing MDX files for a matching `campaignSlug` frontmatter value before writing. Duplicate slugs are skipped (or overwritten with `--force`). This prevents re-publishing the same campaign.

4. **`INDUSTRIES` is intentionally duplicated.** `src/content/config.ts` and `scripts/lib/schemas.ts` both define the list so CLI scripts don't need to import from the Astro `src/` tree. Add values to both files. Never rename or remove existing values — orphaned case studies fail the build.

5. **UTM attribution is separated by placement.** `FloatingCta.astro` includes `utm_term=floating_bar`; `Cta.astro` omits `utm_term`. This distinction is how analytics can separate top-bar vs bottom-section clicks.

6. **The `story` field is the MDX body, not frontmatter.** `mdx.ts` writes Claude's `story` HTML after the frontmatter closing `---`. The Astro content collection renders it as the page body via `<slot />` in `CaseStudy.astro`.

7. **Per-campaign git commits.** Each slug gets one commit so `git log --oneline` reads as a changelog of case study publications. Do not batch-commit multiple slugs.

8. **`GITHUB_TOKEN` pushes do not retrigger `push:` workflows.** GitHub blocks recursion. Detect.yml uses an explicit `workflow_dispatch` API call to trigger `deploy.yml` after pushing content commits.

---

## Brand Tokens (`tailwind.config.mjs`)

| Token | Hex | Primary use |
|---|---|---|
| `honeycomb-yellow` | #F7B731 | Metric tile accent, logo |
| `honeycomb-cream` | #FBF9F2 | Page background |
| `honeycomb-purple` | #4A1D96 | CTA bar (`FloatingCta`), primary buttons |
| `honeycomb-blue` | #1C4ED8 | Links |
| `honeycomb-green` | #10B981 | Status indicators |
| `honeycomb-ink` | #1A1A1A | Body text, borders |
| Font display | Raleway | Headings, labels |
| Font body/sans | Open Sans | Body copy, UI |

---

## Runtime Prompt (`prompts/case-study-prompt.md`)

The ~1,000-line prompt is the primary specification for what Claude generates. Sections:

| Section | Content |
|---|---|
| §1 | Role definition (staff content writer at Honeycomb Credit) |
| §2 | Target reader (small-business owner, peer to the featured business) |
| §3 | Input schema (14 fields from the scrape payload) |
| §4 | Output schema (14 JSON keys; exact specs) |
| §5 | Voice rules (5 Do's, 5 Don'ts, CTA selection table) |
| §6 | Narrative structure (five-beat arc, 800–1,200 words; Beat 4 handles partial-funded) |
| §6.7 | Voice & rhythm (specificity ladder, scaffolding rules, Wikipedia test, pull-quote density) |
| §7 | Hero section rules (H1, subhead, image alt, story heading) |
| §8 | Keyword tags + industry (controlled vocabulary) |
| §9 | Schema.org JSON-LD (LocalBusiness + Article) |
| §10 | Slug rules (kebab-case, 3–6 words, business name required) |
| §11 | Rich-text HTML allowlist |
| §12 | Humanization failure modes (AI-tell patterns; mirrors `humanization-rules.ts`) |
| §13 | Grounding rule (every claim must be traceable to the input payload) |
| §13.5 | Hard-gate circuit-breaker checks (run before returning JSON) |
| §14 | Self-check checklist (24 items) |
| §15 | Worked example (bone broth case study with full input/output) |

Template substitution: `{{HUMANIZATION_BANNED_VOCAB}}`, `{{HUMANIZATION_HEDGE_PHRASES}}`, `{{HUMANIZATION_STRUCTURAL_PATTERNS}}` are replaced at runtime by `claude.ts` with content from `humanization-rules.ts`.

---

## Operator Portal (`src/pages/admin/index.astro`)

Static page at `/admin` on GitHub Pages. No backend.

- **Auth model:** Operator pastes a GitHub fine-grained PAT (issues:write on this repo) into the browser; it's stored in `localStorage` and sent only to `api.github.com`.
- **Actions available:** Generate, Redraft, Delete, Inspect, Backfill, Status/cost-estimate
- **Protocol:** Each action opens a tracking GitHub Issue and posts the corresponding `/funded` slash command as the first comment. `on-comment.yml` picks it up from there.
- **Excluded from sitemap** (astro.config.mjs filter) and served with `noindex` (BaseHead).
- **Sharing access:** Add the coworker as a repo Collaborator (Write permission). They create their own PAT; the workflow's `author_association` check validates identity on every action.
