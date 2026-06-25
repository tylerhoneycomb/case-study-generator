# CLAUDE.md — Collateral Development Agent v4.0

This file is the canonical technical brief for the `funded.honeycombcredit.com` codebase. It is written so that an AI coding tool could understand the full system and recreate it. Read this before modifying any file.

---

## What This Project Is

An autonomous agent that publishes a marketing case study for every funded Honeycomb Credit campaign. "The repo itself is the agent" — GitHub Actions orchestrates everything; there is no external server.

- **Live site:** https://funded.honeycombcredit.com
- **Operator portal:** https://funded.honeycombcredit.com/admin
- **Audit log:** https://github.com/tylerhoneycomb/case-study-generator/issues

---

## Architecture

```
GitHub Actions (detect.yml)
  └─ scripts/detect.ts          ← discovers newly funded campaigns via PostHog
       └─ scripts/lib/pipeline.ts  ← per-slug: scrape → Claude → validate → image → MDX → git commit
            └─ deploy.yml           ← Astro build + GitHub Pages deploy on push to main
```

Every action — cron, slash command, Issue Form, operator portal — converges on the same `scripts/lib/pipeline.ts` and the same GitHub Issues audit log.

> **⚠ Cron is currently PAUSED** (2026-06-09) to stop Anthropic API spend while the project is on hold. Resume by uncommenting the two `cron:` lines in `.github/workflows/detect.yml`.

---

## Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Site framework | Astro | 5.1.5 |
| Language | TypeScript (strict, `noUncheckedIndexedAccess`) | 5.7.2 |
| Styling | Tailwind CSS | 3.4.17 |
| Content | Astro MDX content collections | @astrojs/mdx 4.0.3 |
| Schema validation | Zod | 3.24.1 |
| AI generation | Anthropic SDK / Claude Opus 4.7 | @anthropic-ai/sdk 0.65.0 |
| GitHub API | Octokit REST | @octokit/rest 21.0.2 |
| Script runner | tsx | 4.19.2 |
| Testing | Vitest | 2.1.8 |
| Hosting | GitHub Pages (private repo, GitHub Pro) | — |
| Node | ≥ 20 (see `.nvmrc`) | — |
| Fonts | Raleway (display) + Open Sans (body) | @fontsource/* 5.x |

---

## Repository Structure

```
.github/
  workflows/
    deploy.yml          ← Astro build + Pages deploy on push to main
    detect.yml          ← cron at 04:47 / 11:23 UTC daily (PAUSED 2026-06-09)
    on-comment.yml      ← /funded slash dispatcher (issues + PRs)
    on-issue.yml        ← Issue Form dispatcher (routes by title prefix)
  ISSUE_TEMPLATE/
    backfill.yml
    redraft-with-feedback.yml
    config.yml

.state/
  detection-log.md      ← audit trail: one row per cron run (committed)
  ratelimit.json        ← today's generation counter (NOT committed; per-run only)

prompts/
  case-study-prompt.md  ← 1005-line runtime prompt sent to Claude on every generation

public/
  og/                   ← hero / OG images, one per case study ({slug}.{ext})
  CNAME                 ← funded.honeycombcredit.com

scripts/
  detect.ts             ← cron entry point
  generate.ts           ← generate one case study end-to-end
  redraft.ts            ← regenerate with feedback
  delete.ts             ← remove a case study
  inspect.ts            ← diagnostic (no spend, no commits)
  backfill.ts           ← batch-process historical campaigns
  status.ts             ← check rate-limit status
  cost-estimate.ts      ← estimate API spend
  dispatch-comment.ts   ← on-comment.yml handler
  dispatch-issue.ts     ← on-issue.yml handler
  lib/
    pipeline.ts         ← shared per-slug generation pipeline
    claude.ts           ← Anthropic SDK wrapper + output validation
    posthog.ts          ← HogQL client for campaign discovery
    scrape.ts           ← fetch campaign data from invest.honeycombcredit.com
    humanize.ts         ← AI-tells regex validator
    humanization-rules.ts  ← shared banned-word config + prompt substitutions
    mdx.ts              ← MDX read/write, idempotency by campaignSlug
    image.ts            ← hero image fetch + store to public/og/
    github.ts           ← Octokit wrappers
    ratelimit.ts        ← 1/day default, 10/day backfill cap, UTC reset
    schemas.ts          ← Zod schemas (ClaudeOutputSchema, CampaignSchema)
    git.ts              ← git operations
    format.ts           ← money/time formatting
    log.ts              ← structured logging
    args.ts             ← argument parsing
    parse-slugs.ts      ← backfill slug parser (defends against code-fence drift)
    *.test.ts           ← unit tests (57 tests, gate every deploy)

src/
  content/
    case-studies/       ← one .mdx per funded campaign (pipeline writes here)
    config.ts           ← Zod schema; single source of truth for MDX frontmatter
  pages/
    [...slug].astro     ← case-study renderer (dynamic routing)
    index.astro         ← gallery page (newest first)
    admin/index.astro   ← operator portal (noindex, no backend)
    rss.xml.js          ← /rss.xml feed
  layouts/
    CaseStudy.astro     ← case-study page layout
  components/
    Hero.astro          ← hero section (image, H1, subhead)
    MetricsStrip.astro  ← three-tile metric grid (Raised / Investors / Time to fund)
    Quote.astro         ← optional founder quote block
    Cta.astro           ← bottom-of-page pre-qualify CTA
    FloatingCta.astro   ← sticky top-bar CTA (scroll-reveal, session-dismissible)
    JsonLd.astro        ← Schema.org JSON-LD emission
    BaseHead.astro      ← meta/OG tags, canonical, robots
    SiteHeader.astro    ← navigation
    SiteFooter.astro    ← footer
  styles/

astro.config.mjs        ← Astro config (site domain, build format, integrations)
tailwind.config.mjs     ← Honeycomb brand palette (yellow, purple, blue, green, cream, ink)
tsconfig.json           ← strict TypeScript, bundler resolution, path alias ~/
vitest.config.mts       ← unit test config
package.json            ← scripts, dependencies
.env.example            ← ANTHROPIC_API_KEY, GITHUB_TOKEN
.nvmrc                  ← Node 20
```

---

## Core Generation Pipeline

`scripts/lib/pipeline.ts` — `runPipeline(slug)` — is the heart of the system. Every operator surface (generate, redraft, backfill, cron) calls it.

### 6 Stages

1. **Scrape** (`scrape.ts`) — fetch `invest.honeycombcredit.com/campaigns/{slug}`, extract `__NEXT_DATA__` + HTML. Builds a `Campaign` object (validated by `CampaignSchema`).

2. **Claude** (`claude.ts`) — call Claude Opus 4.7 with `prompts/case-study-prompt.md` + campaign payload. Returns a 14-key JSON object (validated by `ClaudeOutputSchema`). Retries once on humanization failure.

3. **Humanize** (`humanize.ts`) — regex validator that flags AI writing tells (banned vocabulary, hedge phrases, em-dash density, tricolon density). Matches rules in `humanization-rules.ts`. On second attempt, publishes with `humanization-warning` label rather than blocking.

4. **Image** (`image.ts`) — fetch hero/OG image from campaign page, store to `public/og/{slug}.{ext}`. Falls back through `ogImageUrl` → `campaignMedia[]` → deep-scan for any Honeycomb uploads URL.

5. **MDX** (`mdx.ts`) — assemble frontmatter from Claude output + campaign data, write to `src/content/case-studies/{slug}.mdx`. Idempotent: checks for existing file by `campaignSlug` field.

6. **Commit** (`git.ts`) — `git add` + `git commit` with message `feat(case-study): publish {businessName}`. One commit per campaign.

---

## Schema Contracts (Three Layers)

Three Zod schemas gate different boundaries. All three must stay in sync.

### 1. `scripts/lib/schemas.ts` — `ClaudeOutputSchema` (14 keys)
What Claude must return. Validated before anything is written to disk.

| Key | Description |
|---|---|
| `h1Heading` | Page H1 (6–14 words, must do work) |
| `heroSubhead` | Subheadline below H1 |
| `storyHeading` | H2 inside the narrative body |
| `story` | 800–1,200-word narrative body (rich-text HTML) |
| `heroImageAlt` | Alt text for hero image |
| `metaTitle` | `<title>` tag (40–70 chars) |
| `metaDescription` | Meta description (120–180 chars) |
| `ogTitle` | OG title (30–80 chars) |
| `ogDescription` | OG description (60–160 chars) |
| `ctaText` | CTA button label |
| `slug` | URL slug (lowercase kebab-case) |
| `niche` | Short business niche descriptor (2–80 chars) |
| `industry` | One of 12 controlled-vocabulary values (see `INDUSTRIES`) |
| `systemSchemaJson` | JSON-LD array (LocalBusiness subtype + Article) |

### 2. `scripts/lib/schemas.ts` — `CampaignSchema`
What `scrape.ts` extracts from `invest.honeycombcredit.com`. Defensive: only required fields are non-optional. When Honeycomb's `__NEXT_DATA__` shape changes, this is what catches it.

Key fields: `slug`, `campaignName`, `campaignId`, `campaignStage`, `totalFundsRaised`, `numInvestors`, `campaignStartDate`, `campaignExpirationDate`, `summary`, `useOfProceeds`, `issuer` (city, state), `ogImageUrl`, `campaignMedia`.

### 3. `src/content/config.ts` — content collection schema
Validates MDX frontmatter at Astro build time. Failure fails the build and blocks deploy. The pipeline assembles this from Claude output + campaign data.

**INDUSTRIES controlled vocabulary** (12 values, additive only — never rename to avoid orphaning existing case studies):
`Food & Beverage`, `Retail`, `Health & Wellness`, `Personal Services`, `Professional Services`, `Arts & Entertainment`, `Manufacturing & Craft`, `Agriculture`, `Hospitality`, `Technology`, `Education`, `Other`

**Key design notes:**
- `ctaUrl` was removed in v4.0.x — the pre-qualify URL is built at render time in `Cta.astro` and `FloatingCta.astro` from a constant base + `campaignSlug`. Do not re-add this field.
- `progress-to-goal` was removed as a headline metric in v4.0.x. The `MetricsStrip` shows three tiles: Raised / Investors / Time to fund. Raise vs. target lives in the narrative when it carries weight (prompt §6 Beat 4).
- `heroImage` and `ogImage` are plain path strings (not Astro `image()` helpers) because `public/` assets are unprocessed — this keeps the pipeline's image write a single `fs.writeFile`.

---

## Humanization System

`scripts/lib/humanize.ts` is a port of Honeycomb's `velo_humanization.jsw` validator. It runs after Claude responds and flags copy that reads as AI-generated.

**Checks:**
- Banned vocabulary (specific words that Claude over-uses)
- Hedge phrases ("it's worth noting", "it's important to", etc.)
- Em-dash density (cap per 500 words, threshold in `humanization-rules.ts`)
- Tricolon density (three-part lists, cap per 500 words)
- "Not just/but" constructions

**Flow:** First attempt fails → Claude retries once → second attempt fails → publish anyway with `humanization-warning` label on the tracking issue. Never blocks indefinitely.

`humanization-rules.ts` exports `applyPromptSubstitutions()` which injects `{{HUMANIZATION_*}}` placeholder values into `prompts/case-study-prompt.md` at runtime so the thresholds are always in sync between validator and prompt.

---

## GitHub Actions Workflows

### `deploy.yml` — Astro build + Pages deploy
**Trigger:** Push to `main`, `workflow_dispatch`
**Steps:** typecheck (`astro sync && tsc --noEmit`) → test (57 vitest tests) → build → deploy to Pages. Live within ~2 min of commit.

### `detect.yml` — daily detection cron
**Trigger:** `workflow_dispatch` (cron slots at 04:47 and 11:23 UTC are commented out — currently paused)
**Logic:** PostHog query → filter published → rate-limit check → per-campaign: open tracking issue → `runPipeline()` → push → dispatch `deploy.yml`

Two cron slots because GitHub Actions silently delays or drops scheduled runs under load; running twice/day is idempotent (already-published campaigns are filtered) but rescues days when the first slot misses.

### `on-comment.yml` — slash command dispatcher
**Trigger:** Issue or PR comment starting with `/funded`
**Auth:** Comment author must be a repo collaborator
**Handles:** `/funded generate|redraft|delete|status|cost-estimate|inspect <slug>`

### `on-issue.yml` — Issue Form dispatcher
**Trigger:** New GitHub Issue
**Routes by title prefix:**
- "Backfill case studies" → batch backfill
- "Redraft with feedback" → redraft with feedback field
- "Config" → site configuration changes

---

## Rate Limiting

`scripts/lib/ratelimit.ts` — state file at `.state/ratelimit.json`.

- **Default cap:** 1 generation per UTC day across all triggers
- **Backfill override:** up to 10/day (hard max, applies only to the calling operation)
- **Reset:** UTC midnight (auto-detects stale date on read)
- **State file shape:** `{ "date": "2026-04-28", "used": 2 }`

**Known gap:** `.state/ratelimit.json` is written per workflow run but **not committed back to the repo**. Each new workflow invocation starts fresh at 0. In practice this hasn't caused over-spend (cron runs once/day; backfill caps itself; manual ops are rare) but the "1/day across all triggers" semantic is weaker than documented. Fix: include `ratelimit.json` in the per-slug commit in `pipeline.ts`, with care around concurrent workflows.

Excess work gets a `queued` label on the tracking issue. The cron drains queued issues before scanning for new ones.

---

## Operator Interfaces

### Operator Portal (`/admin`)
- Static Astro page on GitHub Pages — no backend
- Browser stores a GitHub fine-grained PAT in `localStorage` (scoped to `issues: read+write` on this repo)
- Actions call the GitHub API directly from the browser to open tracking issues
- `on-comment.yml` picks up the first comment (the matching `/funded` slash command) and runs the CLI
- Status flows back into the same tracking issue

### Slash Commands (GitHub Issues / PRs)
`/funded generate|redraft|delete|status|cost-estimate|inspect <slug>` in any issue/PR comment. Author must be a repo collaborator (checked by `on-comment.yml`).

### Issue Forms (GitHub Issues → New)
- **Backfill case studies** — `backfill.yml` template; rate override field
- **Redraft with feedback** — `redraft-with-feedback.yml` template
- **Config** — `config.yml` template

---

## Cost Model

| Item | Cost |
|---|---|
| Generate or redraft | ~$0.45 (Claude Opus 4.7, ~17K input + ~2.7K output tokens) |
| Inspect / delete / status | $0 |
| Astro build + Pages deploy | $0 (GitHub Actions free tier) |
| Steady state (~10 funded campaigns/month) | ~$5/month |

---

## Local Development

```bash
cp .env.example .env   # add ANTHROPIC_API_KEY and GITHUB_TOKEN
nvm use                # Node 20+
npm install

npm run dev            # Astro dev server → http://localhost:4321
npm run build          # static output to dist/
npm run typecheck      # astro sync && tsc --noEmit
npm test               # vitest run (57 tests)

# CLI scripts (require ANTHROPIC_API_KEY + GITHUB_TOKEN in env)
npm run inspect -- <slug>                            # diagnostic, no spend, no commits
npm run generate -- <slug>                           # ~$0.45 spend
npm run redraft -- <slug> --feedback="..."           # ~$0.45 spend
npm run delete -- <slug>                             # free
npm run backfill -- --slugs="A\nB\nC" [--force] [--dry-run] [--rate=N]
npm run detect -- [--dry-run]                        # the cron entry point
```

Required env vars:
- `ANTHROPIC_API_KEY` — Anthropic API key (for generation)
- `GITHUB_TOKEN` — GitHub PAT with `contents: write` + `issues: write` on this repo
- `POSTHOG_API_KEY` — PostHog personal API key with `project:query:read` (for detect only)
- `POSTHOG_PROJECT_ID` — numeric PostHog project ID (for detect only)
- `GITHUB_REPOSITORY` — `owner/repo` string (set automatically in Actions; needed locally for `github.ts`)

---

## The Runtime Prompt (`prompts/case-study-prompt.md`)

1005 lines. Sent to Claude Opus 4.7 on every generation. Sections:
1. Role (expert B2B case-study writer)
2. Target reader
3. Input schema (campaign payload)
4. **Output schema** (14 JSON keys — no preamble, pure JSON)
5. Voice and style rules
6. Narrative structure (5-beat arc: opening → stakes → why Honeycomb → the raise → what money did; 800–1,200 words)
7. Hero section rules (H1: 6–14 words, tension/claim/angle; subhead rules)
8. Keyword/tag taxonomy (12-value `industry` controlled vocabulary)
9. Schema.org rules (LocalBusiness subtype + Article, two-entity array)
10. Slug rules (lowercase kebab-case, derived from business name)
11. HTML rules (what tags are allowed in `story`)
12. Failure modes (what to do when campaign data is thin)
13. Grounding rules (no fabrication; everything must trace to input payload)
13.5. Humanization rules (mirrors `humanize.ts` validator)
14. Self-check checklist (Claude reviews its own output before returning)
15. Worked example

`humanization-rules.ts:applyPromptSubstitutions()` injects `{{HUMANIZATION_EM_DASH_THRESHOLD}}` and `{{HUMANIZATION_TRICOLON_THRESHOLD}}` into the prompt at runtime so validator thresholds and prompt instructions stay in sync.

---

## Key Invariants

These must stay true or the system breaks:

1. **`ClaudeOutputSchema` ↔ `src/content/config.ts` ↔ prompt Section 4** must all agree on field names and types. If you add a new output field, update all three plus `pipeline.ts` where it stitches them together.

2. **`INDUSTRIES` enum** is duplicated in `src/content/config.ts` and `scripts/lib/schemas.ts` (so scripts don't import from `src/`). Additive only — never rename a value.

3. **`public/og/` images** are committed alongside MDX files. `heroImage` frontmatter path must match the file written by `image.ts`.

4. **`.state/ratelimit.json` is not committed.** Do not add it to git. It's ephemeral per workflow run.

5. **`ctaUrl` is not a frontmatter field.** The pre-qualify URL is constructed at render time. Do not re-add it.

6. **The `story` field** in Claude output is the MDX body, not a frontmatter field. `pipeline.ts` strips the `story` key from frontmatter and writes it as the file body.

7. **PostHog detection floors at `campaignexpirationdate >= '2026-01-01'`** — ~570 pre-2026 historical campaigns are intentionally excluded from the cron. Use the Backfill Issue Form or `backfill.ts` for historical campaigns.

8. **Tracking issues** are opened before generation, not after. If generation fails, the issue gets an `error` label and stays open. This is intentional — the issue is the audit record.

9. **Deploy is gated** by typecheck + 57-test vitest suite. Any change that breaks either blocks the Pages deploy.

10. **`src/content/config.ts` schema failures fail the build.** If a malformed MDX file reaches `main`, the deploy fails and the old site stays live.

---

## Known Gaps / Roadmap

- **Founder-level input data.** Campaign payload lacks founder name, photo, verbatim Q&A. The "Ask The Founders" tab on each campaign page would unlock this — biggest quality lever still on the roadmap. See prompt §6 for current compensation.
- **Rate-limit persistence is per-run.** See "Rate Limiting" section above.
- **Pre-2026 campaigns not auto-published.** Use Backfill Issue Form or `backfill.ts` for historical campaigns.
