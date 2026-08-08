# CLAUDE.md — Collateral Development Agent

> This file is the authoritative technical reference for the `case-study-generator` repo.
> It is written for an AI coding tool that may need to understand, extend, or recreate the system.

## What this system does

This repo is the **Collateral Development Agent v4.0** — an autonomous pipeline that
generates and publishes a case study for every successfully-funded Honeycomb Credit campaign.

- **Live site**: https://funded.honeycombcredit.com  
- **Operator portal**: https://funded.honeycombcredit.com/admin  
- **Audit log**: GitHub Issues on this repo  

The repo is both the codebase and the data store. Case studies live as `.mdx` files in
`src/content/case-studies/`. GitHub Actions is the runtime; operators drive ad-hoc work
through GitHub Issues, the admin portal, and `/funded` slash commands in any issue comment.

---

## Architecture

```
PostHog HogQL
(funded campaigns)
       │
       ▼
detect.ts ──→ per-slug pipeline ──→ MDX + hero image committed to main
                                           │
                                           ▼
                                    deploy.yml (Astro build → GitHub Pages)
                                           │
                                           ▼
                              funded.honeycombcredit.com
```

The same per-slug pipeline is also reachable via:
- **Operator portal** (`/admin`) — browser form, PAT auth, no backend
- **`/funded` slash commands** — typed in any GitHub issue/PR comment by a collaborator
- **Issue Forms** — Backfill and Redraft templates for high-input operations

All three paths write to the same MDX files, use the same `scripts/lib/pipeline.ts`
entry point, and produce the same commit + deploy flow.

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Astro 5, TypeScript (strict + `noUncheckedIndexedAccess`), Tailwind CSS 3 |
| Content | MDX content collections, Zod schema validation at build time |
| AI | Anthropic SDK — Claude Opus 4.7 by default (~$0.45/generation) |
| Data source | PostHog HogQL (Fivetran-mirrored `postgres.campaigns`) |
| CI/CD | GitHub Actions — 4 workflows (detect, deploy, on-comment, on-issue) |
| Hosting | GitHub Pages (custom domain via `public/CNAME`) |
| Testing | Vitest — 65 tests across 5 test files |
| Runtime | Node ≥ 20, tsx for TypeScript script execution |

---

## Directory layout

```
src/
  content/
    case-studies/       ← one .mdx per funded campaign (agent writes here)
    config.ts           ← Zod schema; single source of truth for frontmatter
  pages/
    index.astro         ← directory listing all case studies
    [...slug].astro     ← case-study renderer (file-based routing)
    admin/index.astro   ← operator portal (noindex, no backend)
    rss.xml.js          ← /rss.xml feed
  layouts/
    CaseStudy.astro     ← hero + metrics + body + CTA layout
  components/           ← Hero, MetricsStrip, Quote, Cta, JsonLd, BaseHead, …
  styles/
    global.css

public/
  og/                   ← hero / OG images, one per case study ({slug}.{ext})
  CNAME                 ← funded.honeycombcredit.com

scripts/
  generate.ts           ← generate one case study
  redraft.ts            ← regenerate with operator feedback
  delete.ts             ← remove a published case study
  inspect.ts            ← diagnostic scrape only, no spend
  detect.ts             ← daily cron entry point
  backfill.ts           ← batch-generate historical campaigns
  status.ts             ← check rate-limit status
  cost-estimate.ts      ← estimate Anthropic spend before running
  dispatch-comment.ts   ← route /funded slash commands
  dispatch-issue.ts     ← route Issue Form submissions
  lib/
    pipeline.ts         ← shared per-slug pipeline (generate/redraft/backfill all use this)
    claude.ts           ← Anthropic SDK wrapper + output validation
    scrape.ts           ← __NEXT_DATA__ + HTML extraction from invest.honeycombcredit.com
    humanize.ts         ← AI-tells regex validator
    humanization-rules.ts ← shared blocked-vocabulary list (used by prompt + validator)
    posthog.ts          ← HogQL client — funded campaign discovery
    mdx.ts              ← MDX read/write, idempotency by campaignSlug
    ratelimit.ts        ← 1/day default, 10/day backfill cap, UTC reset
    github.ts           ← Octokit wrappers (createIssue, addComment, addLabel, …)
    image.ts            ← hero image fetch + storage under public/og/
    schemas.ts          ← Zod schemas: ClaudeOutputSchema, CampaignSchema
    parse-slugs.ts      ← Backfill input parser (defends against code-fence drift)
    git.ts              ← git add/commit helpers
    log.ts              ← structured log + issue-comment stage poster
    format.ts           ← money/time formatters, todayISO()
    args.ts             ← CLI argument parsing
    *.test.ts           ← 65 unit tests across 5 test files

.github/
  workflows/
    deploy.yml          ← Astro build + Pages deploy on push to main
    detect.yml          ← twice-daily cron (04:47 + 11:23 UTC); currently paused
    on-comment.yml      ← /funded slash dispatcher
    on-issue.yml        ← Issue Form dispatcher (routes by title prefix)
  ISSUE_TEMPLATE/
    backfill.yml
    redraft-with-feedback.yml
    config.yml

.state/
  detection-log.md      ← cron heartbeat: one row per run, appended forever
  ratelimit.json        ← today's generation counter (written at runtime, not committed)

prompts/
  case-study-prompt.md  ← 1000+ line runtime prompt sent to Claude on every generation

.env.example            ← required/optional env vars
.nvmrc                  ← Node 20+
astro.config.mjs
tailwind.config.mjs     ← Honeycomb brand palette + fonts
tsconfig.json
vitest.config.mts
package.json
```

---

## Environment variables

| Variable | Required for | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | `generate`, `redraft`, `backfill`, `detect` | Repo secret in CI |
| `GITHUB_TOKEN` | All scripts that open/label issues | Auto-provided in CI; add to `.env` locally |
| `POSTHOG_API_KEY` | `detect` | Personal API key with `project:query:read` scope |
| `POSTHOG_PROJECT_ID` | `detect` | Numeric project ID (Honeycomb Credit Production = 39093) |
| `CASE_STUDY_MODEL` | `generate`, `redraft`, `backfill`, `detect` | Optional override; default is `claude-opus-4-7` |
| `GITHUB_REPOSITORY` | All scripts that use Octokit | Set automatically in CI; format `owner/repo` |
| `FUNDED_BOT_IDENTITY` | `detect`, `on-comment`, `on-issue` dispatchers | Set to `'1'` in CI to suppress self-comments |

---

## Local development

```bash
nvm use                  # Node 20+ (reads .nvmrc)
npm install
cp .env.example .env     # fill in ANTHROPIC_API_KEY at minimum

npm run dev              # http://localhost:4321
npm run build            # static output → dist/
npm run typecheck        # astro sync && tsc --noEmit
npm test                 # vitest run (65 tests)

# Agent CLIs (all require ANTHROPIC_API_KEY)
npm run inspect -- <slug>                         # diagnostic, no spend
npm run generate -- <slug>                        # ~$0.45 spend
npm run redraft -- <slug> --feedback="..."        # ~$0.45 spend
npm run detect -- [--dry-run]                     # needs POSTHOG_API_KEY too

# Or with npx tsx directly:
npx tsx scripts/delete.ts <slug>
npx tsx scripts/status.ts
npx tsx scripts/cost-estimate.ts <slug>
npx tsx scripts/backfill.ts --slugs="A\nB\nC" [--force] [--dry-run] [--rate=N]
```

---

## Generation pipeline

All generate/redraft/backfill paths run through `scripts/lib/pipeline.ts`. Stages in order:

**1. Fetch campaign detail**  
`scrape.ts` fetches `https://invest.honeycombcredit.com/invest/{slug}`, parses
`__NEXT_DATA__` (Next.js hydration JSON), and falls back to HTML parsing.  
The result is validated against `CampaignSchema` (Zod). Failure throws `PipelineError('scrape', …)`.

**2. Call Claude**  
`claude.ts` assembles an `InputPayload` from the campaign data and any caller feedback,
prefixes it with the 1000+-line system prompt (`prompts/case-study-prompt.md`), calls
the Anthropic API, validates the JSON response against `ClaudeOutputSchema`, and validates
the JSON-LD blob with `isValidJsonLd()`. The model returns 14 required keys.

**3. Humanization validation (retry-on-fail)**  
`humanize.ts` runs a regex-based AI-tells validator over the `story` field. If any issues
are found, the pipeline retries Claude once with the validator's feedback appended to
`redraftFeedback`. If the retry also fails, the pipeline publishes anyway and returns
`humanizationWarnings` in the result — the caller applies a `humanization-warning` label.
Max attempts: `MAX_HUMANIZATION_ATTEMPTS = 2`.

**4. Fetch and store hero image**  
`image.ts` fetches the hero image via `extractHeroImageUrl()` (priority: `pageProps.ogImageUrl`
→ `campaign.ogImageUrl` → top-level alternates → `campaignMedia[]` → deep-scan → HTML regex)
and saves it under `public/og/{output-slug}.{ext}`.

**5. Write MDX**  
`mdx.ts` writes `src/content/case-studies/{slug}.mdx` with YAML frontmatter + the `story`
HTML as the body. Idempotent by `campaignSlug` — the same campaign always produces the same
file path.

**6. git commit**  
`git.ts` stages `{mdx-path}` + `public/og/{image-path}` and commits with message:  
`feat(case-study): publish {campaignName} ({outputSlug})`

---

## Claude output schema (14 required keys)

Claude returns a single JSON object. `ClaudeOutputSchema` in `scripts/lib/schemas.ts` validates it.

| Key | Purpose | Constraints |
|---|---|---|
| `h1Heading` | Page H1 | min 20 chars |
| `heroSubhead` | Subhead beneath H1 | min 20 chars |
| `storyHeading` | Section heading above body | min 4 chars |
| `story` | Rich-text HTML body | Allowed tags: p, h2–h6, a, b, strong, i, em, ul, ol, li, br, span |
| `heroImageAlt` | Alt text for hero image | 8–200 chars |
| `metaTitle` | `<title>` tag | 40–70 chars |
| `metaDescription` | `<meta name="description">` | 120–180 chars |
| `ogTitle` | Open Graph title | 30–80 chars |
| `ogDescription` | Open Graph description | 60–160 chars |
| `ctaText` | Call-to-action button text | min 3 chars |
| `slug` | URL slug for the case study | 3–6 words, lowercase, hyphenated; distinct from campaign slug |
| `niche` | Free-form niche descriptor | 2–80 chars |
| `industry` | Controlled vocab | One of 12 values (see `src/content/config.ts` `INDUSTRIES`) |
| `systemSchemaJson` | JSON-LD blob | LocalBusiness/subtype + Article entities |

---

## MDX frontmatter schema

Every `src/content/case-studies/*.mdx` file has frontmatter validated at build time by
`src/content/config.ts`. Fields:

**Identity**: `businessName`, `niche`, `industry`, `city`, `state` (2-letter uppercase)

**Headings**: `h1Heading`, `heroSubhead`, `storyHeading`

**Images**: `heroImage` (path `/og/*.{ext}`), `heroImageAlt`, `ogImage` (optional, usually same as heroImage)

**Quote** (optional, not generated by pipeline): `quote`, `quoteAttribution`

**Metrics**: `amountRaised` (int), `amountRaisedFormatted`, `investorCount` (int), `timeToFund` (string, e.g. "21 days")

**SEO**: `metaTitle` (40–70), `metaDescription` (120–180), `ogTitle` (30–80), `ogDescription` (60–160), `canonicalOverride` (optional URL)

**CTA**: `ctaText` — Note: `ctaUrl` was removed in v4.0.x; `Cta.astro` builds the URL from a constant base + `campaignSlug`

**Traceability**: `campaignUrl`, `campaignId`, `campaignSlug`

**Date**: `publishedDate` (ISO date string, coerced to Date)

**Schema**: `systemSchemaJson` (JSON-LD array or object)

---

## Campaign discovery (PostHog)

`scripts/lib/posthog.ts` runs a HogQL query against the Fivetran-mirrored
`postgres.campaigns` table in PostHog. The query returns funded campaigns with
`campaignexpirationdate >= '2026-01-01'`, ordered newest first. Campaigns where
`campaignSlug` is already in the published MDX set are filtered out before any
rate-limit is consumed.

Pre-2026 campaigns are intentionally excluded by the cron (operators use the
Backfill Issue Form to hand-pick historical campaigns).

---

## GitHub Actions workflows

### `deploy.yml`
Trigger: push to `main`, `workflow_dispatch`.  
Steps: `npm run typecheck` → `npm test` → `npm run build` → upload `dist/` → deploy to Pages.  
Concurrency: `pages` group, `cancel-in-progress: false` (never clobber an in-flight deploy).

### `detect.yml`
Trigger: `workflow_dispatch` only (schedule commented out — **currently paused** since 2026-06-09).  
To resume: uncomment the `schedule:` block (two slots: `47 4 * * *` and `23 11 * * *`).  
Steps: checkout → install → `detect.ts` → `git push origin HEAD:main` → dispatch `deploy.yml`.  
Required secrets: `ANTHROPIC_API_KEY`, `POSTHOG_API_KEY`, `POSTHOG_PROJECT_ID`.

### `on-comment.yml`
Trigger: `issue_comment` created.  
Auth guard: `author_association` must be `OWNER`, `COLLABORATOR`, or `MEMBER`.  
Acknowledges with 👀 reaction, then runs `dispatch-comment.ts`.  
Supported commands: `/funded generate|redraft|delete|status|cost-estimate|inspect <slug>`

### `on-issue.yml`
Trigger: issues opened/edited/labeled.  
Routes by title prefix: `[Backfill]` → `backfill.ts`; `[Redraft]` → `redraft.ts`.  
Anti-replay guard: applies a `dispatched` label to prevent re-firing on subsequent edits.

---

## Rate limiting

`scripts/lib/ratelimit.ts` enforces a daily generation budget:

| Context | Limit |
|---|---|
| Default (cron + manual) | 1/day |
| Backfill (`--rate=N`) | 10/day cap (caller-overridable) |

State is stored in `.state/ratelimit.json` and resets at UTC midnight.

**Known gap**: `.state/ratelimit.json` is written during a workflow run but not committed
back to the repo. Each new workflow invocation starts with a fresh 0-of-N budget. In
practice this hasn't caused over-spend (cron runs at most twice/day; manual ops are
infrequent), but the documented "1/day across all triggers" semantic is weaker than
intended. Fix: commit `ratelimit.json` inside the per-slug commit in `pipeline.ts`.

---

## Three Zod validation boundaries

| File | Validates | Failure mode |
|---|---|---|
| `src/content/config.ts` | MDX frontmatter at build time | Astro build fails; deploy never ships |
| `scripts/lib/schemas.ts` `ClaudeOutputSchema` | Claude's 14-key JSON response | Pipeline throws `ClaudeError('OUTPUT_VALIDATION_FAILED', …)` |
| `scripts/lib/schemas.ts` `CampaignSchema` | Honeycomb scrape payload | Pipeline throws `PipelineError('scrape', …)` |

When Honeycomb's `__NEXT_DATA__` shape changes, `CampaignSchema` catches it first.

---

## Cost model

| Operation | Cost |
|---|---|
| Generate or redraft | ~$0.45 (Opus 4.7; ~17K input + ~2.7K output tokens) |
| Inspect / delete / status / cost-estimate | $0 |
| Build + Pages deploy | $0 (GitHub Actions free tier) |
| Steady state at ~10 campaigns/month | ~$5/month |

Pricing table in `scripts/lib/claude.ts`:

| Model | Input per Mtok | Output per Mtok |
|---|---|---|
| `claude-opus-4-7` (default) | $15 | $75 |
| `claude-sonnet-4-6` | $3 | $15 |
| `claude-haiku-4-5-20251001` | $1 | $5 |

Override the model via the `CASE_STUDY_MODEL` env var.

---

## Humanization rules

`scripts/lib/humanization-rules.ts` is the single source of truth for the AI-tells
blocked vocabulary. Both the runtime prompt (`prompts/case-study-prompt.md`) and the
post-generation validator (`scripts/lib/humanize.ts`) read from this file via
`applyPromptSubstitutions()`. Adding a word to the rules file automatically updates
both the prompt (so Claude avoids it) and the validator (so the validator catches it).

The validator checks the `story` and `metaDescription` fields for:
- Banned vocabulary (hedge phrases, corporate filler, AI tells)
- "Not just X but Y" patterns
- Generic openers
- Tricolon density excess
- Em-dash density excess

---

## Critical invariants — do not break these

1. **Build gate**: `src/content/config.ts` schema must stay in sync with what the pipeline
   writes. If you add a required frontmatter field, also update `pipeline.ts` to write it,
   and vice versa. A mismatch fails the deploy.

2. **Industry vocabulary**: `INDUSTRIES` in `src/content/config.ts` is additive-only.
   Never rename or remove a value — that would orphan existing MDX files and fail the build.
   Mirror any additions in the runtime prompt (Section 8 of `prompts/case-study-prompt.md`).

3. **Idempotency by `campaignSlug`**: `mdx.ts` uses `campaignSlug` (the Honeycomb platform
   slug) to find existing files. The agent-chosen `slug` (the public URL slug Claude writes)
   may differ from the campaign slug. Do not confuse them.

4. **`ctaUrl` was removed**: `Cta.astro` constructs the CTA URL at render time from a
   constant base + `campaignSlug`. Do not re-add `ctaUrl` to frontmatter.

5. **Numeric rounding**: `amountRaised` and `investorCount` must be integers in frontmatter
   (`z.number().int()`). The pipeline rounds with `Math.round()` before writing. Honeycomb's
   JSON can carry float imprecision (e.g., `46841.50001525879`).

6. **JSON-LD shape**: `systemSchemaJson` must be an array of typed JSON-LD entities, a
   single typed entity, or an `@graph` wrapper. `isValidJsonLd()` in `claude.ts` validates
   this. The cap is 8000 chars serialized.

7. **Humanization retry policy**: `MAX_HUMANIZATION_ATTEMPTS = 2`. The pipeline publishes
   after both attempts regardless of humanization outcome. The validator is a quality signal,
   not a hard gate. The prompt (§13.5) frames it as a hard gate for motivational reasons only.

8. **GITHUB_TOKEN push behavior**: Pushes authenticated with `GITHUB_TOKEN` do not trigger
   downstream `push:` workflows (GitHub recursion safeguard). The detect and on-comment
   workflows explicitly dispatch `deploy.yml` via `gh workflow run deploy.yml --ref main`
   after every content push.

---

## Known gaps

- **Founder-level data missing.** The input payload lacks the founder's name, photo, and
  verbatim Q&A from the "Ask The Founders" tab. Adding it is the single biggest quality lever
  remaining. See `prompts/case-study-prompt.md` §6 for how the prompt compensates today.

- **Rate-limit persistence is per-run, not per-day.** See "Rate limiting" above.

- **Pre-2026 campaigns excluded from cron.** The PostHog query floors at 2026-01-01.
  Historical campaigns must be published via the Backfill Issue Form.

- **Cron currently paused.** Disabled 2026-06-09 to halt Anthropic API spend while the
  project is on hold. Uncommenting the `schedule:` block in `detect.yml` resumes it.
