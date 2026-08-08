# CLAUDE.md — Collateral Development Agent

This file gives an AI coding tool everything it needs to understand, extend, and maintain this codebase. Read it before touching anything.

## What this repo is

**funded.honeycombcredit.com** — a static site that publishes one SEO case study per funded Honeycomb Credit community-investment campaign. The **repo itself is the agent**: GitHub Actions runs detection on a cron, operators trigger ad-hoc actions through GitHub Issues and a web portal, and the case studies live as MDX files committed directly here.

Published site: https://funded.honeycombcredit.com  
Operator portal (most day-to-day work): https://funded.honeycombcredit.com/admin  
Audit log: https://github.com/tylerhoneycomb/case-study-generator/issues

## Tech stack

| Layer | Technology |
|---|---|
| Site framework | Astro 5 (static output) + MDX content collections |
| Styling | Tailwind CSS 3 (Honeycomb brand palette) |
| Language | TypeScript 5 (strict, `noUncheckedIndexedAccess`) |
| Hosting | GitHub Pages from private repo (GitHub Pro) |
| Automation | GitHub Actions (cron, on-comment dispatcher, on-issue dispatcher, deploy) |
| LLM | Anthropic SDK — Claude Opus 4.7 by default (`CASE_STUDY_MODEL` env var overrides) |
| Discovery | PostHog HogQL — Fivetran-mirrored `postgres.campaigns` |
| Scraping | invest.honeycombcredit.com `__NEXT_DATA__` extraction |
| Validation | Zod (3 schema layers) + Vitest (65 tests) |
| GitHub client | Octokit REST |

## Repository layout

```
src/
  content/case-studies/    ← one .mdx file per funded campaign; agent writes here
  content/config.ts        ← Zod schema (single source of truth for frontmatter fields)
  pages/
    index.astro            ← listing page (homepage)
    [...slug].astro        ← dynamic case-study renderer
    admin/index.astro      ← operator portal (noindex; PAT auth in browser, no backend)
    rss.xml.js             ← /rss.xml feed
  layouts/CaseStudy.astro  ← wraps hero + metrics + body + CTA + floating bar
  components/
    Hero.astro             ← hero image + h1Heading + heroSubhead
    MetricsStrip.astro     ← 3-tile KPI strip: Raised / Investors / Time to fund
    Quote.astro            ← optional founder quote block (hidden when absent)
    Cta.astro              ← static bottom-of-page CTA (UTM-tagged pre-qualify URL)
    FloatingCta.astro      ← floating top bar on scroll; dismissible; utm_term=floating_bar
    JsonLd.astro            ← emits systemSchemaJson in <head>
    BaseHead.astro         ← <head> boilerplate: title, description, OG tags, JSON-LD
    SiteHeader.astro
    SiteFooter.astro
  styles/global.css

public/
  og/                      ← hero + OG images (one per case study, .png/.jpg/.webp/.svg)
  demo/floating-cta.html   ← noindex design comparison demo for FloatingCta
  CNAME                    ← funded.honeycombcredit.com

scripts/
  generate.ts              ← generate one case study (idempotency check + rate limit)
  redraft.ts               ← regenerate with reviewer feedback (keeps same URL/slug)
  delete.ts                ← remove a case study + its image
  backfill.ts              ← bulk historical generation (up to 10/day override)
  detect.ts                ← daily cron entry point (discovery → pipeline → push)
  inspect.ts               ← diagnostic only; no API spend, no commits
  status.ts                ← query rate-limit status
  cost-estimate.ts         ← cost calculator (no API call)
  dispatch-comment.ts      ← internal: parses /funded slash commands from on-comment.yml
  dispatch-issue.ts        ← internal: routes issue forms from on-issue.yml
  lib/
    pipeline.ts            ← shared 6-stage per-slug pipeline
    claude.ts              ← Anthropic SDK wrapper + prompt loader
    posthog.ts             ← HogQL discovery client
    scrape.ts              ← invest.honeycombcredit.com scraper (__NEXT_DATA__ + HTML fallback)
    humanize.ts            ← AI-tells regex validator (circuit breaker)
    humanization-rules.ts  ← shared rules config (prompt substitutions + validator rules)
    mdx.ts                 ← MDX read/write; idempotency by campaignSlug
    image.ts               ← hero image fetcher + storer (6-path fallback chain)
    github.ts              ← Octokit wrappers (createIssue, addComment, addLabel, closeIssue)
    ratelimit.ts           ← 1/day default, 10/day backfill cap, UTC reset
    git.ts                 ← git CLI wrappers (add, commit, push)
    schemas.ts             ← Zod schemas: ClaudeOutputSchema, CampaignSchema, ListingEntrySchema
    format.ts              ← formatMoney(), formatTimeToFund()
    parse-slugs.ts         ← backfill input parser (defends against code-fence drift)
    log.ts                 ← logging + tracking-issue comment posting
    args.ts                ← CLI arg parser

.github/
  workflows/
    deploy.yml             ← npm ci → typecheck → test (65) → astro build → Pages deploy
    detect.yml             ← daily cron (04:47 + 11:23 UTC); currently PAUSED since 2026-06-09
    on-comment.yml         ← /funded slash command dispatcher (author_association gate)
    on-issue.yml           ← issue form dispatcher (routes by title prefix)
  ISSUE_TEMPLATE/
    backfill.yml           ← "Backfill case studies" form
    redraft-with-feedback.yml
    config.yml

.state/
  detection-log.md         ← one row per cron run (audit trail, committed)
  ratelimit.json           ← today's counter (NOT committed — see Known gaps)

prompts/
  case-study-prompt.md     ← ~1000-line runtime system prompt sent to Claude on every generation
```

## Generation pipeline (6 stages)

`scripts/lib/pipeline.ts` runs these in order for every campaign slug:

1. **Fetch detail** — `scrape.fetchCampaign(slug)` extracts `__NEXT_DATA__` from invest.honeycombcredit.com
2. **Call Claude** — `claude.generateCaseStudy(payload)` with retry on humanization failure (max 2 attempts; on final failure, publish anyway with `humanization-warning` label)
3. **Humanization validator** — `humanize.validateCopy(plain)` regex circuit breaker (AI-tells: banned vocabulary, hedge phrases, em-dash density, tricolon density, generic openers)
4. **Hero image** — `image.fetchAndStoreHeroImage()` to `public/og/{slug}.{ext}` (6-path fallback chain)
5. **Write MDX** — `mdx.writeCaseStudy()` — frontmatter + rich-text HTML body to `src/content/case-studies/{slug}.mdx`
6. **Git commit** — `git.commit('feat(case-study): publish {name} ({slug})')`

Each stage posts a status comment to the tracking GitHub issue.

## Schema layers (three Zod boundaries)

| Schema | File | Validates | Failure mode |
|---|---|---|---|
| `CaseStudySchema` | `src/content/config.ts` | MDX frontmatter at Astro build time | Build fails; deploy blocked |
| `ClaudeOutputSchema` | `scripts/lib/schemas.ts` | Claude's 14-key JSON response | Generation fails; `error` label on issue |
| `CampaignSchema` | `scripts/lib/schemas.ts` | Scraped invest.honeycombcredit.com payload | Scrape fails; `error` label on issue |

**When `__NEXT_DATA__` shape drifts** (Honeycomb platform changes), `CampaignSchema` catches it first. All non-required fields are optional to absorb minor shape changes; required fields throw explicitly.

## Content collection schema

`src/content/config.ts` defines all frontmatter fields. Key fields:

| Group | Fields |
|---|---|
| Identity | `businessName`, `niche`, `industry` (12-value enum), `city`, `state` (2-letter) |
| Headings | `h1Heading`, `heroSubhead`, `storyHeading` |
| Hero/OG image | `heroImage`, `heroImageAlt`, `ogImage` (optional) |
| Founder quote | `quote` (optional), `quoteAttribution` (optional) |
| Metrics | `amountRaised`, `amountRaisedFormatted`, `investorCount`, `timeToFund` |
| SEO | `metaTitle`, `metaDescription`, `ogTitle`, `ogDescription`, `canonicalOverride` (optional) |
| CTA | `ctaText` |
| Source traceability | `campaignUrl`, `campaignId`, `campaignSlug` |
| Date | `publishedDate` |
| JSON-LD | `systemSchemaJson` (LocalBusiness + Article pair) |

**Progress-to-goal fields (`goalAmount`, `goalAmountFormatted`, `percentOfGoal`, `percentOfGoalFormatted`) were removed in 2026-06.** The metrics strip is now 3 tiles: Raised / Investors / Time to fund. The narrative still addresses partial-funded outcomes when they matter (see `prompts/case-study-prompt.md` §6 Beat 4).

**Industry enum (additive-only — never rename):**  
Food & Beverage, Retail, Health & Wellness, Personal Services, Professional Services, Arts & Entertainment, Manufacturing & Craft, Agriculture, Hospitality, Technology, Education, Other

## Claude output contract (14 keys)

`ClaudeOutputSchema` in `scripts/lib/schemas.ts` is the exact JSON shape Claude must return. Any change to the prompt's Section 4 must be mirrored in this schema and `src/content/config.ts`. The 14 keys are:

`slug`, `h1Heading`, `heroSubhead`, `storyHeading`, `heroImageAlt`, `story` (rich-text HTML body), `tags`, `industry`, `metaTitle`, `metaDescription`, `ogTitle`, `ogDescription`, `ctaText`, `systemSchemaJson`

## Runtime prompt

`prompts/case-study-prompt.md` is the system prompt sent to Claude on every generation. It is loaded once per process and has `{{HUMANIZATION_*}}` placeholders substituted from `scripts/lib/humanization-rules.ts` at runtime, so banned-word changes in the rules file propagate automatically to both the validator and the prompt.

Key sections:
- §3 — Input schema (11 scraped fields + `todayISO`)
- §4 — Output schema (14 required JSON keys above)
- §5 — Voice rules (specific, grounded, human-centered; not investor-speak)
- §6 — 5-beat narrative arc (Opening → Business & Stakes → Why Honeycomb → The Raise & Community → What the Money Did)
- §8 — Industry enum (mirror of `src/content/config.ts` `INDUSTRIES`)
- §9 — JSON-LD schema (LocalBusiness/subtype + Article pair)
- §12 — AI-tells to avoid (banned phrases, em-dash/tricolon density caps)
- §14 — 24-point self-check checklist
- §15 — Worked example (Brothmonger bone broth, Brooklyn)

**Do not change the prompt without also updating** `humanization-rules.ts` (banned vocabulary), `scripts/lib/schemas.ts` (`ClaudeOutputSchema`), and `src/content/config.ts` (frontmatter schema). They must stay in sync.

## Humanization validator

`scripts/lib/humanize.ts` is a regex-based circuit breaker, not a semantic model. It runs after every Claude response and checks:
- Banned vocabulary (clichés, hedge-filler, VC-speak)
- Generic openers ("In the heart of", "Nestled in", "In today's")
- "not just ... but ..." constructions
- Tricolon density (cap: 3.5 per 500 words)
- Em-dash density (cap: 1.5 per 500 words)

Rules live in `humanization-rules.ts` — single source of truth for both the validator and the prompt.

Retry policy: 2 attempts. On the second failure, the case study is published anyway with a `humanization-warning` label so an operator can redraft with specific feedback.

## Idempotency

`scripts/lib/mdx.ts` deduplicates by `campaignSlug` frontmatter (not by filename). Before writing, `findByCampaignSlug(slug)` walks all MDX files. This prevents duplicate files when Claude picks a slightly different output slug across calls.

`scripts/generate.ts` also checks `findByCampaignSlug` before consuming the rate limit or calling the API.

## Rate limiting

`scripts/lib/ratelimit.ts` reads/writes `.state/ratelimit.json`. Default cap: **1/day**. Backfill can override to **10/day** via `--rate=N`. Excess candidates are deferred silently; the `queued` issue label surfaces them.

**Known gap:** `.state/ratelimit.json` is not committed back to the repo, so each workflow invocation starts with a fresh 0-of-1 budget. In practice this hasn't caused overspend (the cron fires once per day; backfill self-caps; manual ops are infrequent).

## Floating CTA bar (FloatingCta.astro)

A sticky purple "Get prequalified today!" bar pinned to the top of every case study. Behavior:
- Hidden on load; slides down once the reader scrolls past the hero
- Dismissible (session storage; doesn't nag across pages)
- `position: fixed` — never overlaps the non-sticky site header
- UTM: same destination as `Cta.astro` but adds `utm_term=floating_bar` for separate attribution

The design comparison lives at `/demo/floating-cta.html` (noindex). Rendered from `CaseStudy.astro` right after `<body>`.

## GitHub Actions workflows

### deploy.yml
Triggers on push to `main` or `workflow_dispatch`. Steps: `npm ci` → typecheck (`astro sync && tsc --noEmit`) → 65-test suite (`vitest run`) → `astro build` → upload artifact → deploy to GitHub Pages. Live within ~2 min of any commit to main.

### detect.yml — **CURRENTLY PAUSED**
Daily cron disabled 2026-06-09 (Tyler's request; Anthropic API spend on hold). Two slots were configured: `47 4 * * *` (04:47 UTC) and `23 11 * * *` (11:23 UTC). `workflow_dispatch` remains active for one-off runs. To re-arm: uncomment the two `schedule:` lines in `.github/workflows/detect.yml`.

Detection flow:
1. PostHog HogQL: funded campaigns (`Funded` or `Successful - Finalizing`) with `campaignexpirationdate >= '2026-01-01'`
2. Diff against `listAllCampaignSlugs()` (already-published filter)
3. For each eligible: consume rate limit → run pipeline → open tracking issue → append detection-log row
4. Push commits to main; dispatch `deploy.yml` if changed

### on-comment.yml
Triggers on `issue_comment` from `{OWNER, COLLABORATOR, MEMBER}`. Parses `/funded <action> <slug> [--feedback="..."]` and routes to `dispatch-comment.ts`. Supported actions: `generate`, `redraft`, `delete`, `inspect`, `status`, `cost-estimate`, `backfill`.

### on-issue.yml
Triggers on `issues` opened. Routes by issue title prefix to `dispatch-issue.ts`. Handles Backfill and Redraft-with-feedback issue forms.

## Local development

```bash
nvm use                 # Node 20+
npm install
npm run dev             # http://localhost:4321
npm run build           # static output to dist/
npm run typecheck       # astro sync && tsc --noEmit
npm test                # vitest run (65 tests)
```

CLI scripts require `ANTHROPIC_API_KEY` (for generation) and `GITHUB_TOKEN` (for issue management) in env.

```bash
npx tsx scripts/inspect.ts <slug>            # diagnostic; no API spend, no commits
npx tsx scripts/generate.ts <slug> [--issue=N] [--force]
npx tsx scripts/redraft.ts <slug> --feedback="..."
npx tsx scripts/delete.ts <slug>
npx tsx scripts/backfill.ts --slugs="A\nB\nC" [--force] [--dry-run] [--rate=N]
npx tsx scripts/detect.ts [--dry-run]        # full cron entry point
npx tsx scripts/status.ts                    # rate-limit status
npx tsx scripts/cost-estimate.ts <slug>      # cost estimate without calling API
```

## Cost model

| Operation | Cost |
|---|---|
| Generate or redraft | ~$0.45 (Opus 4.7, ~17K input + ~2.8K output tokens) |
| Inspect / delete / status / cost-estimate | $0 |
| Deploy (Astro build + Pages) | $0 (GitHub Actions free tier) |
| Steady state (~10 campaigns/month) | ~$5/month |

Model pricing baked into `scripts/lib/claude.ts`:
- Opus 4.7: $15 input / $75 output per Mtok
- Sonnet 4.6: $3 / $15
- Haiku 4.5: $1 / $5

Override model with `CASE_STUDY_MODEL` env var.

## Known gaps

1. **Founder-level input data** — The scrape payload has no founder name, photo, or Q&A. The "Ask The Founders" tab on campaign pages would unlock this (biggest quality lever on the roadmap). See `prompts/case-study-prompt.md` §6 for current compensation strategy.

2. **Rate-limit persistence is per-run, not per-day** — `.state/ratelimit.json` is not committed back, so multiple workflow invocations in one day each start with a fresh budget. Fix: commit the file in `pipeline.ts` per-slug; watch for race conditions if workflows overlap.

3. **Pre-2026 historical campaigns not auto-published** — Detection floors at `campaignexpirationdate >= '2026-01-01'`. ~570 historical campaigns are in PostHog but intentionally skipped; use the Backfill Issue Form to publish specific ones.

4. **Image fallback chain** — `image.ts` walks 6 paths to find a hero image. Fragile if invest.honeycombcredit.com's `__NEXT_DATA__` shape drifts further.

5. **Prompt version coupling** — Prompt, validator, `ClaudeOutputSchema`, and `src/content/config.ts` must all be updated together. There is no automated contract check between them.

## Operator portal

`src/pages/admin/index.astro` is a fully static page with no backend. Auth: a fine-grained GitHub PAT (issues:write on this repo) stored in `localStorage`. The PAT is never sent anywhere except `api.github.com`. All actions (generate/redraft/delete/inspect) open a tracking issue via the GitHub API, which triggers the corresponding `on-issue.yml` or `on-comment.yml` workflow. Requires collaborator-level access (`author_association` in `{OWNER, COLLABORATOR, MEMBER}`).

Full operator documentation lives inline on the portal page under the `⚠ Read me first` accordion.
