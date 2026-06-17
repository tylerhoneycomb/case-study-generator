# CLAUDE.md — Collateral Development Agent

Technical reference for AI-assisted development on this repo. Covers architecture,
invariants, and common task patterns. Read this before editing any `scripts/` or
`src/` files.

---

## What this repo is

**funded.honeycombcredit.com** — a static site that publishes one case study per
funded Honeycomb Credit campaign. The repo itself is the agent: GitHub Actions
runs discovery and generation; case studies live as MDX files committed directly
here; all operator actions are audit-trailed through GitHub Issues.

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Astro 5, TypeScript (strict + `noUncheckedIndexedAccess`), Tailwind CSS, MDX content collections |
| Hosting | GitHub Pages (custom domain via `public/CNAME`) |
| AI generation | Anthropic Claude (`claude-opus-4-7` default, ~$0.45/study) |
| Campaign discovery | PostHog HogQL against Fivetran-mirrored `postgres.campaigns` |
| Campaign content | `__NEXT_DATA__` scrape from `invest.honeycombcredit.com` |
| Orchestration | GitHub Actions (cron + slash-commands + Issue Forms) |
| Testing | Vitest (65 tests) + `tsc --noEmit` (strict) gate every deploy |
| Schema validation | Zod at three boundaries (scrape, Claude output, MDX frontmatter) |

---

## Repository layout

```
src/
  content/
    config.ts                 ← Zod schema; single source of truth for MDX frontmatter
    case-studies/             ← one .mdx per published campaign (agent writes here)
  pages/
    index.astro               ← directory listing (newest-first)
    [...slug].astro           ← dynamic case-study renderer
    admin/index.astro         ← operator portal (noindex)
    rss.xml.js                ← /rss.xml feed
  layouts/CaseStudy.astro     ← case-study layout (hero + metrics + body + CTA)
  components/                 ← Hero, MetricsStrip, Quote, Cta, JsonLd, BaseHead, …
  styles/global.css
public/
  CNAME                       ← funded.honeycombcredit.com
  og/                         ← hero / OG images (one per case study, agent writes here)
scripts/
  generate.ts                 ← one-shot: generate a single case study by slug
  redraft.ts                  ← re-generate with reviewer feedback
  detect.ts                   ← cron entry point: discover + rate-limit + generate
  delete.ts                   ← remove a case study (MDX + image)
  backfill.ts                 ← bulk historical import
  inspect.ts                  ← diagnostic: scrape + Claude dry-run, no commit
  status.ts                   ← rate-limit + detection-log status
  cost-estimate.ts            ← token/cost forecast without calling Claude
  dispatch-comment.ts         ← routes /funded slash commands from on-comment.yml
  dispatch-issue.ts           ← routes [Backfill] / [Redraft] Issue Forms
  lib/
    pipeline.ts               ← shared 6-stage per-slug pipeline
    claude.ts                 ← Anthropic SDK wrapper + output validation
    scrape.ts                 ← __NEXT_DATA__ + HTML extraction; hero-image fallbacks
    posthog.ts                ← HogQL discovery client
    humanize.ts               ← AI-tells regex validator (circuit-breaker)
    humanization-rules.ts     ← banned vocab/phrases/patterns — SINGLE SOURCE OF TRUTH
    mdx.ts                    ← MDX read/write; idempotency by campaignSlug
    image.ts                  ← hero image fetch + storage in public/og/
    github.ts                 ← Octokit wrappers (createIssue, addComment, …)
    ratelimit.ts              ← 1/day default, 10/day backfill cap, UTC reset
    schemas.ts                ← ClaudeOutputSchema + CampaignSchema (Zod)
    parse-slugs.ts            ← Backfill input parser (defends against code-fence drift)
    format.ts git.ts log.ts args.ts
    *.test.ts                 ← unit tests (65 total across 5 files)
.github/
  workflows/
    detect.yml                ← cron 04:47 UTC + 11:23 UTC (2× daily for resilience)
    deploy.yml                ← typecheck → test → build → Pages on push to main
    on-comment.yml            ← /funded slash-command dispatcher
    on-issue.yml              ← Issue Form dispatcher ([Backfill] / [Redraft])
  ISSUE_TEMPLATE/
    backfill.yml redraft-with-feedback.yml config.yml
prompts/
  case-study-prompt.md        ← runtime system prompt sent to Claude (~1000 lines)
.state/
  detection-log.md            ← append-only daily cron heartbeat (committed)
  ratelimit.json              ← today's generation counter (written but NOT committed)
```

---

## The 6-stage generation pipeline (`scripts/lib/pipeline.ts`)

All entry points (`generate.ts`, `redraft.ts`, `backfill.ts`, `detect.ts`) call
`runPipeline(slug, opts)`. Stages in order:

1. **Open tracking issue** — `github.ts#createIssue()`. Every pipeline run is
   anchored to a GitHub Issue; subsequent stages post comments to it.

2. **Scrape campaign** — `scrape.ts#fetchCampaign()`. GETs
   `invest.honeycombcredit.com/campaigns/{slug}`, extracts `__NEXT_DATA__` JSON,
   parses with `CampaignSchema` (Zod). Fails hard if the page 404s or the schema
   rejects the payload.

3. **Generate with Claude** — `claude.ts#generateCaseStudy()`. Loads
   `prompts/case-study-prompt.md`, substitutes `{{HUMANIZATION_*}}` placeholders
   from `humanization-rules.ts`, sends to Claude. Validates the 14-key JSON
   response against `ClaudeOutputSchema`.

4. **Humanization check** — `humanize.ts#checkHumanization()`. Runs regex
   circuit-breaker against `story` and `metaDescription`. On first failure,
   re-calls Claude with flagged issues injected as `redraftFeedback`. On second
   failure, publishes with `humanization-warning` label (hard gate was retired
   in #39 / #41 after leaving real campaigns unpublished).

5. **Fetch hero image** — `image.ts`. Copies `ogImageUrl` from scrape to
   `public/og/{slug}.{ext}`. Falls back through a cascade of
   `campaignMedia[]` fields if the canonical URL is missing.

6. **Write MDX + commit** — `mdx.ts#writeCaseStudy()`, then `git.ts#commitAndPush()`.
   MDX path: `src/content/case-studies/{slug}.mdx`. Commit message:
   `[case-study] {businessName}: {slug}`.

---

## Zod validation boundaries

Three schemas gate three separate failure points:

| File | Schema | Validates | Failure |
|---|---|---|---|
| `src/content/config.ts` | (Astro schema) | MDX frontmatter at build time | Astro build fails; deploy doesn't ship |
| `scripts/lib/schemas.ts` | `ClaudeOutputSchema` | Claude's 14-key JSON response | Pipeline fails; tracking issue gets `error` label |
| `scripts/lib/schemas.ts` | `CampaignSchema` | Honeycomb `__NEXT_DATA__` scrape | Pipeline fails; tracking issue gets `error` label |

When `src/content/config.ts` and `scripts/lib/schemas.ts` diverge, the build
will fail. Keep them in sync whenever you add or rename a frontmatter field.

---

## Humanization rules — where to edit

`scripts/lib/humanization-rules.ts` is the **only** file you should edit to add
or remove banned phrases, vocabulary, or patterns. Both consumers update
automatically:

- `scripts/lib/humanize.ts` — builds the regex set for post-generation validation
- `scripts/lib/claude.ts` — injects the rule lists into the runtime prompt before
  sending to Claude (via `applyPromptSubstitutions()`)

Do not hardcode banned strings in `prompts/case-study-prompt.md`; use the
`{{HUMANIZATION_*}}` placeholders that are already there.

---

## Claude output contract

Claude must return a JSON object (no preamble, no trailing commentary) with
exactly these 14 keys. Validated by `ClaudeOutputSchema` in `schemas.ts`.

| Key | Constraint |
|---|---|
| `h1Heading` | 6–14 words; editorial hook, not labeling |
| `heroSubhead` | 8–16 words; concrete scene, not an H1 restatement |
| `storyHeading` | 4–10 words; H2 opener specific to the business |
| `story` | 800–1200 words; HTML rich-text with 5 narrative beats and 3–4 `<h2>` headings |
| `heroImageAlt` | 8–16 words; photo description |
| `metaTitle` | 50–60 chars; keyword phrase in the first half |
| `metaDescription` | 140–160 chars; sentence form with dollar amount and a detail |
| `ogTitle` | 40–70 chars; scroll-stopping, may differ from `metaTitle` |
| `ogDescription` | 80–140 chars; conversational one-liner |
| `ctaText` | 3–7 words; industry-native action verb |
| `slug` | kebab-case, 3–6 words, includes business name, distinct from Honeycomb's slug |
| `niche` | 2–6 words (e.g. `"bone broth and soup maker"`) |
| `industry` | enum — 12 values defined in `config.ts`; additive only, never remove |
| `systemSchemaJson` | JSON-LD array `[LocalBusiness/subtype, Article]`; 8 KB max |

The pipeline also writes agent-supplied fields (not from Claude) into frontmatter:
`businessName`, `city`, `state`, `amountRaised`, `amountRaisedFormatted`,
`goalAmount`, `percentOfGoal`, `investorCount`, `timeToFund`, `campaignUrl`,
`campaignId`, `campaignSlug`, `publishedDate`, `heroImage`, `ogImage`.

---

## Rate limiting

`scripts/lib/ratelimit.ts` — `consume()` / `canConsume()`.

- Default cap: **1 generation per UTC day** across all triggers combined.
- Backfill override cap: **10/day** (hard ceiling, enforced in code).
- State file: `.state/ratelimit.json` — written by the script but **not committed**
  back to the repo. Each new workflow invocation starts with a fresh 0-of-1 budget.
  This is a known gap; see README "Known gaps" section.

---

## Cron schedule

Two daily slots in `.github/workflows/detect.yml`:

```
47 4 * * *   # 04:47 UTC = 00:47 EDT  — overnight, low GitHub contention
23 11 * * *  # 11:23 UTC = 07:23 EDT  — mid-morning backup
```

Both runs are idempotent — `listAllCampaignSlugs()` in `mdx.ts` filters already-
published campaigns before any rate-limit token is consumed, so double-running
costs nothing when the first slot lands cleanly.

---

## Deploy gate

Every push to `main` runs `deploy.yml`:

1. `npm run typecheck` — `astro sync && tsc --noEmit`
2. `npm test` — `vitest run` (65 tests)
3. `npm run build` — Astro → `dist/`
4. Upload to GitHub Pages

A failing typecheck or test blocks the deploy. The cron push and slash-command
push both trigger this workflow via an explicit `gh workflow run deploy.yml`
dispatch (GitHub's recursion safeguard blocks the normal `push:` trigger when
the push uses `GITHUB_TOKEN`).

---

## Idempotency

The key idempotency check is `mdx.ts#findByCampaignSlug(campaignSlug)`:

- Walks every `.mdx` file in `src/content/case-studies/`
- Parses YAML frontmatter to read the `campaignSlug` field
- Returns the matching file if one exists

This means idempotency is keyed on **Honeycomb's campaign slug** (from the
platform URL), not the case-study's own output slug. A redraft of an existing
case study uses `forcedOutputSlug` to overwrite the same MDX file.

---

## Required environment variables

| Variable | Required by | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | generate, redraft, backfill, detect | — |
| `GITHUB_TOKEN` | all scripts that open/comment on issues | — |
| `POSTHOG_API_KEY` | detect | — |
| `POSTHOG_PROJECT_ID` | detect | — |
| `POSTHOG_HOST` | detect | `https://us.posthog.com` |
| `CASE_STUDY_MODEL` | generate, redraft, backfill, detect | `claude-opus-4-7` |

Copy `.env.example` to `.env` for local development.

---

## Common development tasks

### Add a banned phrase to the humanization validator

Edit `scripts/lib/humanization-rules.ts`. Add a `PhrasePattern` entry to the
appropriate array (`BANNED_VOCABULARY`, `BANNED_HEDGE_PHRASES`, etc.). The
validator and the runtime prompt both update automatically on next run.

Run `npm test` to make sure the new rule doesn't break existing tests.

### Add a new frontmatter field

1. Add to `ClaudeOutputSchema` in `scripts/lib/schemas.ts` (if Claude-generated)
   or assemble it in `pipeline.ts` (if agent-supplied).
2. Add to `src/content/config.ts` (the Astro collection schema).
3. Reference it in `src/layouts/CaseStudy.astro` or the relevant component.
4. Update `scripts/lib/mdx.ts#writeCaseStudy()` to include it in the frontmatter block.

If the field is required, add a test case to the relevant `.test.ts` file.

### Change the Claude model

Set `CASE_STUDY_MODEL` in `.env` (local) or as a repo secret (CI). The pricing
table in `scripts/lib/claude.ts` covers `claude-opus-4-7`, `claude-sonnet-4-6`,
and `claude-haiku-4-5-20251001`. Add a new entry if switching to a different model.

### Edit the generation prompt

Edit `prompts/case-study-prompt.md`. Use `{{HUMANIZATION_VOCABULARY}}`,
`{{HUMANIZATION_HEDGE_PHRASES}}`, etc. for banned-word lists — do not hardcode
them; they come from `humanization-rules.ts` at runtime.

### Run the full pipeline locally (dry-run)

```bash
npm run detect -- --dry-run    # scans PostHog, logs what would run, no generation
npm run inspect -- <slug>      # scrapes + formats payload, no Claude call
```

### Generate a single case study locally

```bash
npm run generate -- <slug>     # ~$0.45 spend
```

This requires `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, and a valid Honeycomb campaign
slug (the part after `/campaigns/` in the invest.honeycombcredit.com URL).

---

## Known gaps

1. **Rate-limit persistence** — `.state/ratelimit.json` is written but not
   committed, so the "1/day" semantic is per-invocation, not per-UTC-day across
   multiple workflow runs. The fix is to commit the file in `pipeline.ts` after
   each `consume()` call. Watch for race conditions if cron and a manual trigger
   overlap.

2. **Founder-level data missing** — The scrape payload has no founder name, photo,
   or verbatim quotes. The "Ask The Founders" tab on each campaign page would
   unlock this. The prompt compensates today with generic second-person framing,
   but first-person attribution would meaningfully improve quality.

3. **Pre-2026 campaigns are not auto-processed** — The PostHog HogQL query floors
   at `campaignexpirationdate >= '2026-01-01'`. ~570 older funded campaigns are
   intentionally skipped by the cron. Use the Backfill Issue Form to publish any
   specific historical campaigns on demand.
