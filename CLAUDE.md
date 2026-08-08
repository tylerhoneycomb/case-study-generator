# CLAUDE.md — Case Study Generator

Authoritative technical reference for the Honeycomb Credit case-study generator. Written for AI coding tools; a human reading this cold should be able to understand and extend the system without reading all source files first.

---

## What this project is

A fully automated content pipeline that publishes a case study for every funded Honeycomb Credit campaign. The output is a static Astro site at **https://funded.honeycombcredit.com**. The repo itself is the agent: GitHub Actions drives discovery and generation; case studies live as MDX files committed to this repo; every push to `main` rebuilds and deploys the site automatically.

### Operator surfaces

| Surface | URL / location |
|---|---|
| Live site | https://funded.honeycombcredit.com |
| Operator portal | https://funded.honeycombcredit.com/admin |
| Audit log | GitHub Issues tab |
| Cron heartbeat | `.state/detection-log.md` |

---

## Current operational status

**Daily cron: PAUSED** (as of 2026-06-09). The `schedule` block in `.github/workflows/detect.yml` is commented out. `workflow_dispatch` is still active; re-arm by uncommenting the schedule lines. All manual triggers (operator portal, slash commands, Issue Forms) work normally.

28 case studies are published. All funded campaigns with `campaignexpirationdate >= '2026-01-01'` have been published. Pre-2026 campaigns require manual backfill via the Issue Form.

---

## Architecture

```
[PostHog / Fivetran]
        │ HogQL query (funded campaigns, ≥ 2026-01-01, not yet published)
        ▼
scripts/detect.ts  ←── daily cron (detect.yml) or workflow_dispatch
        │
        │ per slug
        ▼
scripts/lib/pipeline.ts  (shared by detect / generate / redraft / backfill)
  1. scrape.ts       — fetch invest.honeycombcredit.com (__NEXT_DATA__ + HTML)
  2. claude.ts       — call Claude with prompts/case-study-prompt.md + payload
  3. humanize.ts     — regex validator for AI-tells (two-strike retry, then publish)
  4. image.ts        — fetch hero image from Honeycomb CDN → public/og/
  5. mdx.ts          — write src/content/case-studies/<slug>.mdx
  6. git.ts          — git add + commit + push to main
        │
        ▼
deploy.yml  — Astro build → GitHub Pages (live within ~2 min of push)
```

The same pipeline is triggered by:
- **Operator portal** — https://funded.honeycombcredit.com/admin (PAT auth, no backend)
- **Slash commands** — `/funded generate|redraft|delete|status|cost-estimate|inspect <slug>` in any GitHub issue/PR comment by a repo collaborator
- **Issue Forms** — Issues → New → "Backfill case studies" or "Redraft with feedback"

All paths converge on the same GitHub Issues audit log and the same `scripts/` CLI.

---

## Stack

- **Astro 5** — static site, MDX content collections, file-based routing
- **TypeScript** — strict mode, `noUncheckedIndexedAccess`, `noImplicitOverride`
- **Tailwind CSS** — Honeycomb brand colors (see `tailwind.config.mjs`)
- **GitHub Pages** — deployed from a private GitHub Pro repo
- **GitHub Actions** — cron, on-comment dispatcher, on-issue dispatcher, deploy
- **Anthropic SDK** — Claude claude-sonnet-4-6 (or latest Opus) for generation (~$0.45/study)
- **Vitest** — 65 unit tests across 5 test files
- **Zod** — three-layer validation (see below)
- **Octokit** — GitHub API for audit issues, labels, comments
- **tsx** — TypeScript executor for CLI scripts

---

## Local development

```bash
nvm use               # Node 20+ (see .nvmrc)
npm install
npm run dev           # http://localhost:4321
npm run build         # static output to dist/
npm run typecheck     # astro sync && tsc --noEmit
npm test              # vitest run (65 tests)
```

CLI scripts need `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` in the environment. In CI both are provided automatically via repo secrets.

```bash
npx tsx scripts/inspect.ts <slug>                          # diagnostic — no spend
npx tsx scripts/generate.ts <slug>                         # ~$0.45 spend
npx tsx scripts/redraft.ts <slug> --feedback="..."         # regenerate with feedback
npx tsx scripts/delete.ts <slug>                           # remove published study
npx tsx scripts/backfill.ts --slugs="A\nB\nC" [--force] [--dry-run] [--rate=N]
npx tsx scripts/detect.ts [--dry-run]                      # cron entry point
npx tsx scripts/status.ts                                  # rate-limit / queue status
npx tsx scripts/cost-estimate.ts <slug>                    # estimate cost, no spend
```

---

## Repo layout

```
src/
  content/
    config.ts             ← Zod schema; single source of truth for MDX frontmatter
    case-studies/         ← one .mdx per published campaign (agent writes here)
  pages/
    index.astro           ← directory / index page
    [...slug].astro       ← case-study renderer
    admin/index.astro     ← operator portal (noindex)
    rss.xml.js            ← /rss.xml
  layouts/
    CaseStudy.astro       ← case-study layout (hero + metrics strip + body + CTA)
  components/
    Hero.astro            ← hero image + H1 + subhead
    MetricsStrip.astro    ← three-tile KPI bar: Raised / Investors / Time to fund
    Quote.astro           ← optional founder quote block
    Cta.astro             ← pre-qualify CTA (UTM-tagged, constant URL)
    JsonLd.astro          ← Schema.org JSON-LD emitted in <head>
    BaseHead.astro        ← <head> meta, OG, canonical
    SiteHeader.astro
    SiteFooter.astro
  styles/
    global.css

public/
  og/                     ← hero / OG images, one per case study (agent writes here)
  CNAME                   ← funded.honeycombcredit.com

scripts/
  generate.ts             ← generate one case study end-to-end
  redraft.ts              ← regenerate with operator feedback (replaces MDX)
  delete.ts               ← remove a published case study
  backfill.ts             ← batch-generate historical slugs
  detect.ts               ← cron entry point: PostHog scan → pipeline per slug
  inspect.ts              ← diagnostic (no Claude call, no spend)
  status.ts               ← check rate limit & queue
  cost-estimate.ts        ← estimate $ to generate a slug (no spend)
  dispatch-comment.ts     ← parse /funded slash commands from GitHub comments
  dispatch-issue.ts       ← route Issue Form submissions by title prefix
  lib/
    pipeline.ts           ← shared per-slug pipeline (333 lines)
    scrape.ts             ← invest.hc campaign scraper (__NEXT_DATA__ + HTML)
    posthog.ts            ← HogQL client, funded-campaign discovery
    claude.ts             ← Anthropic SDK wrapper, output validation
    humanize.ts           ← AI-tells regex validator
    humanization-rules.ts ← banned phrases, words, openers (193 lines)
    ratelimit.ts          ← rate limiting (1/day default, UTC reset)
    mdx.ts                ← MDX read/write, idempotency by campaignSlug
    github.ts             ← Octokit wrappers (createIssue, addComment, addLabel)
    image.ts              ← hero image fetch + store to public/og/
    git.ts                ← git add / commit / push helpers
    format.ts             ← slug, money, date, time-to-fund formatters
    log.ts                ← structured logging with tracking issue integration
    schemas.ts            ← Zod: ClaudeOutputSchema, CampaignSchema
    parse-slugs.ts        ← backfill input parser (guards against code-fence drift)
    args.ts               ← CLI argument parser
    *.test.ts             ← Vitest tests (humanize, posthog, scrape, parse-slugs, format)

.github/
  workflows/
    deploy.yml            ← Astro build + Pages deploy on push to main
    detect.yml            ← daily cron (PAUSED — uncomment schedule block to re-arm)
    on-comment.yml        ← /funded slash dispatcher
    on-issue.yml          ← Issue Form dispatcher (routes by title prefix)
  ISSUE_TEMPLATE/
    backfill.yml
    redraft-with-feedback.yml
    config.yml

.state/
  detection-log.md        ← daily cron heartbeat (one row per run, append-only)
  ratelimit.json          ← today's generation counter (written per run, not committed)

prompts/
  case-study-prompt.md    ← runtime prompt sent to Claude on every generation (1005 lines)
```

---

## Content schema (MDX frontmatter)

Defined in `src/content/config.ts`. Validated by Astro at build time — a malformed MDX file fails the build and never reaches production.

### Identity
| Field | Type | Description |
|---|---|---|
| `businessName` | string | Campaign / business name |
| `niche` | string (2–80 chars) | 2–6 word descriptor, agent-derived |
| `industry` | enum (12 values) | Controlled vocabulary — see `INDUSTRIES` in config.ts |
| `city` | string | City from campaign |
| `state` | string (2 chars, uppercase) | US state abbreviation |

### Headings
| Field | Type |
|---|---|
| `h1Heading` | string (min 20 chars) |
| `heroSubhead` | string (min 20 chars) |
| `storyHeading` | string (min 4 chars) |

### Hero / OG image
| Field | Type | Notes |
|---|---|---|
| `heroImage` | string | Path under `/og/`, e.g. `/og/slug.png` |
| `heroImageAlt` | string (8–200 chars) | Descriptive alt text |
| `ogImage` | string (optional) | Defaults to heroImage if absent |

### Optional founder quote
| Field | Type |
|---|---|
| `quote` | string (optional) |
| `quoteAttribution` | string (optional) |

### Metrics (drives the three-tile MetricsStrip)
| Field | Type | Description |
|---|---|---|
| `amountRaised` | integer ≥ 0 | Raw dollar amount |
| `amountRaisedFormatted` | string | e.g. `$31,591` |
| `investorCount` | integer ≥ 0 | Number of investors |
| `timeToFund` | string | e.g. `"21 days"`, `"about a month"` |

> **Note:** `goalAmount`, `goalAmountFormatted`, `percentOfGoal`, `percentOfGoalFormatted` were removed in the 2026-06-09 `feat(metrics)` commit. The "Of goal" tile no longer appears on case study pages. Partial-funded outcomes are still addressed in the narrative (Beat 4 of `prompts/case-study-prompt.md`), not as a visual KPI.

### SEO
| Field | Type | Constraints |
|---|---|---|
| `metaTitle` | string | 40–70 chars |
| `metaDescription` | string | 120–180 chars |
| `ogTitle` | string | 30–80 chars |
| `ogDescription` | string | 60–160 chars |
| `canonicalOverride` | URL (optional) | Overrides default canonical |

### CTA
| Field | Type | Notes |
|---|---|---|
| `ctaText` | string (min 3 chars) | Agent-written, use-of-proceeds-driven |

> `ctaUrl` was removed in v4.0.x. The pre-qualify URL is a constant in `src/components/Cta.astro`, UTM-tagged at render time using `campaignSlug`.

### Source traceability
| Field | Type |
|---|---|
| `campaignUrl` | URL |
| `campaignId` | string |
| `campaignSlug` | string (Honeycomb platform slug — distinct from this site's URL slug) |

### Dates
| Field | Type |
|---|---|
| `publishedDate` | date (coerced) |

### Schema.org
| Field | Type |
|---|---|
| `systemSchemaJson` | object or array | LocalBusiness + Article JSON-LD, emitted in `<head>` |

---

## Validation layers (3-tier Zod)

| File | Validates | Failure mode |
|---|---|---|
| `src/content/config.ts` | MDX frontmatter at Astro build time | Build fails; deploy never ships |
| `scripts/lib/schemas.ts` `ClaudeOutputSchema` | Claude's 14-key JSON response | Generation fails; tracking issue gets `error` label |
| `scripts/lib/schemas.ts` `CampaignSchema` | Honeycomb scrape payload | Scrape fails; tracking issue gets `error` label |

---

## Claude generation pipeline detail

`scripts/lib/pipeline.ts` runs these stages for every slug:

1. **Scrape** (`scrape.ts`) — fetch `invest.honeycombcredit.com/<slug>`, extract `__NEXT_DATA__` JSON + HTML fallbacks.
2. **Generate** (`claude.ts`) — call Claude with `prompts/case-study-prompt.md` + campaign JSON payload. Validates response against `ClaudeOutputSchema`.
3. **Humanize** (`humanize.ts`) — regex-validate story + metaDescription against banned phrases, vocabulary, and openings. On first failure, re-call Claude with validator feedback spliced into `redraftFeedback`. If second attempt also fails, publish anyway and apply `humanization-warning` label. (Hard-gate was removed after real funded campaigns were blocked by false positives — see `#39`, `#41`.)
4. **Image** (`image.ts`) — fetch hero image from Honeycomb CDN, write to `public/og/<slug>.<ext>`.
5. **MDX** (`mdx.ts`) — write frontmatter + body to `src/content/case-studies/<slug>.mdx`. Idempotent by `campaignSlug`; will not overwrite unless `--force`.
6. **Git** (`git.ts`) — `git add` + `git commit` + `git push` to `main`.

After the push, `deploy.yml` triggers automatically and the site rebuilds in ~2 minutes.

---

## Humanization validator

`scripts/lib/humanize.ts` and `scripts/lib/humanization-rules.ts` enforce the quality rules from `prompts/case-study-prompt.md §12`.

**Hard blocks (single occurrence fails):**
- Banned vocabulary: "empower," "unlock," "leverage," "ecosystem," "groundbreaking," "synergy," "seamless," "transformative," and ~20 others
- Banned hedge phrases: "It is worth noting," "When it comes to," "That framing matters because," etc.
- "Not just X, but Y" constructions
- Generic openers: "In the heart of…," "Have you ever wondered…," "Imagine…," etc.

**Density limits (per 500 words):**
- Em-dashes (`—`): threshold from `humanization-rules.ts`
- Tricolons ("A, B, and C" with 1–3 word items): threshold from `humanization-rules.ts`

---

## Rate limiting

`scripts/lib/ratelimit.ts` controls generation spend across all triggers.

- **Default cap:** 1/day per trigger type (cron + manual + portal combined)
- **Backfill override:** up to 10/day
- **Reset:** UTC midnight
- **Excess:** queues to next day via `queued` label on the tracking issue; cron drains queued issues before scanning for new ones

> **Known gap:** `.state/ratelimit.json` is written by `consume()` during a workflow run but not committed back to the repo. Each new workflow invocation starts with a fresh 0-of-1 budget. This hasn't caused overspend in practice (cron runs once/day; backfill self-caps; manual ops are infrequent), but the "1/day across all triggers" semantic is more permissive than intended. Fix: commit `ratelimit.json` in `pipeline.ts` per-slug; needs race-condition analysis for concurrent workflow runs.

---

## Cost model

| Item | Cost |
|---|---|
| Generate or redraft | ~$0.45/call (Claude Opus, ~17K input + ~2.7K output tokens) |
| Inspect / delete / status / cost-estimate | $0 |
| Astro build + Pages deploy | $0 (GitHub Actions free tier) |
| Steady state at ~10 funded campaigns/month | ~$5/month |

---

## GitHub Actions workflows

### `deploy.yml`
Triggers on push to `main` and `workflow_dispatch`. Runs: typecheck → test (65 tests) → `astro build` → upload artifact → deploy to GitHub Pages. Concurrency: single slot (no concurrent deploys).

### `detect.yml`
**Currently PAUSED** (schedule block commented out). When active: fires on two UTC slots daily (04:47 and 11:23). Runs `scripts/detect.ts`, pushes any generated content to `main`, which triggers `deploy.yml`. `workflow_dispatch` is always active.

### `on-comment.yml`
Listens for `/funded <command> <slug>` in any issue or PR comment by a repo collaborator. Routes to the matching CLI script via `dispatch-comment.ts`.

### `on-issue.yml`
Listens for new issues. Routes by title prefix to the matching CLI script via `dispatch-issue.ts` (e.g., "Backfill" → `backfill.ts`, "Redraft" → `redraft.ts`).

---

## Environment variables

| Variable | Required for | Source in CI |
|---|---|---|
| `ANTHROPIC_API_KEY` | `generate`, `redraft`, `backfill`, `detect` | Repo secret |
| `GITHUB_TOKEN` | All scripts that touch GitHub Issues | `secrets.GITHUB_TOKEN` (automatic) |
| `POSTHOG_API_KEY` | `detect.ts` (PostHog HogQL queries) | Repo secret |
| `POSTHOG_PROJECT_ID` | `detect.ts` | Repo secret |

For local development, put these in your shell environment or a `.env` file (not committed).

---

## Brand / design tokens

Defined in `tailwind.config.mjs`:

| Token | Hex | Use |
|---|---|---|
| `honeycomb-yellow` | `#FFDE17` | Dominant accent (first MetricsStrip tile, CTAs) |
| `honeycomb-cream` | `#F6F3E5` | Background |
| `honeycomb-purple` | `#3F296B` | Secondary accent |
| `honeycomb-blue` | `#D9ECFF` | Tertiary accent |
| `honeycomb-green` | `#59B16B` | Sparing use |
| `honeycomb-ink` | `#222222` | Body text |

Fonts: **Raleway** (display/headings), **Open Sans** (body/subheads).

---

## Known gaps

1. **Founder-level input data.** Campaign payload (summary + use-of-proceeds + metrics) doesn't include founder name, photo, or verbatim Q&A. The "Ask The Founders" tab on each campaign page would unlock the biggest remaining quality lever. See `prompts/case-study-prompt.md §6` for current compensation.

2. **Rate-limit persistence.** `ratelimit.json` is not committed back to the repo between runs (see Rate limiting section above).

3. **Pre-2026 campaigns.** The PostHog detection query floors at `campaignexpirationdate >= '2026-01-01'`. ~570 historical campaigns are intentionally skipped by the cron. Tyler hand-picks any to publish via the Backfill Issue Form.

---

## Prompt file

`prompts/case-study-prompt.md` (1005 lines) is the full runtime prompt sent to Claude on every generation. It specifies:
- 14 required output fields with character/word counts
- 5-beat narrative structure (800–1200 words)
- Voice rules (Honeycomb brand voice)
- Banned vocabulary and AI-tell detection rules (mirrored in `humanize.ts`)
- Schema.org JSON-LD structure
- Controlled vocabulary for `industry` (12 values — must stay in sync with `src/content/config.ts`)
- A worked example (Brothmonger, Brooklyn bone broth)

When modifying the prompt, keep the `industry` enum in sync with `INDUSTRIES` in `src/content/config.ts`. Adding a new industry value is safe (additive); renaming or removing breaks existing MDX files.
