# CLAUDE.md — Collateral Development Agent v4.0

> This file is the primary reference for AI coding tools working in this repo.
> It describes architecture, conventions, data contracts, and how to extend the system.

## What this project does

**funded.honeycombcredit.com** publishes a case study for every funded Honeycomb Credit
campaign. It is a fully autonomous content agent: a daily cron detects newly-funded
campaigns via PostHog, generates a case study with Claude Opus 4.7, validates it against
AI-writing heuristics, and deploys it as a static Astro site on GitHub Pages — all
without human intervention. Operators can also trigger, redraft, or delete case studies
via a browser portal, GitHub slash commands, or GitHub Issue Forms.

**The repo itself is the agent.** There is no separate backend. Git is the state store.
GitHub Issues is the audit log. GitHub Actions is the orchestration layer.

---

## Tech stack

| Layer | Technology |
|---|---|
| Static site | Astro 5, MDX, Tailwind CSS 3.4, TypeScript 5.7 (strict) |
| Content format | MDX files with Zod-validated frontmatter |
| AI generation | Anthropic SDK — Claude Opus 4.7 (`claude-opus-4-7`) |
| Discovery | PostHog HogQL (Fivetran-mirrored `postgres.campaigns` table) |
| Campaign data | Scraped from `invest.honeycombcredit.com/__NEXT_DATA__` |
| CI/CD | GitHub Actions — cron, webhooks, Astro build, Pages deploy |
| Hosting | GitHub Pages (custom domain: `funded.honeycombcredit.com`) |
| Testing | Vitest 2.1 (65 tests across 5 files) |
| Runtime | Node 20+ (enforced via `.nvmrc`) |

---

## Repository layout

```
.
├── prompts/
│   └── case-study-prompt.md     Runtime system prompt sent to Claude on every
│                                 generation. ~1000 lines. Version pinned in header.
│                                 Do not modify without reading all of §12–13 (validation
│                                 gates) and updating humanization-rules.ts to match.
│
├── scripts/                     All agent logic. Pure TypeScript, run with tsx.
│   ├── generate.ts              CLI: generate one case study by campaign slug
│   ├── redraft.ts               CLI: re-generate with operator feedback
│   ├── delete.ts                CLI: delete a published case study (MDX + image)
│   ├── backfill.ts              CLI: batch-generate historical campaigns
│   ├── detect.ts                Cron entry point — discovery + pipeline invocation
│   ├── inspect.ts               CLI: diagnostic scrape (no Claude call, no cost)
│   ├── status.ts                CLI: show today's rate-limit counter
│   ├── cost-estimate.ts         CLI: estimate generation cost (no API call)
│   ├── dispatch-comment.ts      Routes /funded slash commands from on-comment.yml
│   ├── dispatch-issue.ts        Routes Issue Form submissions from on-issue.yml
│   └── lib/
│       ├── pipeline.ts          ★ Shared 6-stage pipeline (fetch→Claude→humanize→
│       │                          image→MDX→git). Used by generate/redraft/backfill.
│       ├── claude.ts            Anthropic SDK wrapper. generateCaseStudy() + cost.
│       ├── scrape.ts            Parses invest.honeycombcredit.com/__NEXT_DATA__
│       ├── humanize.ts          AI-writing validator (regex rules, retry policy)
│       ├── humanization-rules.ts Shared rule config (banned words, density caps).
│       │                          Changes here auto-propagate to both the prompt
│       │                          (via {{HUMANIZATION_*}} substitutions) and the
│       │                          validator at runtime.
│       ├── posthog.ts           HogQL client — queries funded campaign slugs
│       ├── mdx.ts               MDX read/write; idempotency by campaignSlug
│       ├── ratelimit.ts         Rate-limit ledger (.state/ratelimit.json)
│       ├── schemas.ts           Zod schemas: ClaudeOutputSchema, CampaignSchema
│       ├── image.ts             Download + store hero images under public/og/
│       ├── github.ts            Octokit wrappers (createIssue, addComment, labels)
│       ├── git.ts               Git CLI helpers (add, commit, amend)
│       ├── log.ts               Issue-comment logger (stage/info/warn/error)
│       ├── format.ts            Number/date/time formatters (formatMoney, etc.)
│       ├── args.ts              CLI argument parser
│       └── parse-slugs.ts       Backfill input parser (defends code-fence drift)
│
├── src/
│   ├── content/
│   │   ├── config.ts            ★ Zod schema for MDX frontmatter. Single source of
│   │   │                          truth for what goes in every case study file. Build
│   │   │                          fails if any MDX violates this schema.
│   │   └── case-studies/        One .mdx per published campaign (agent writes here)
│   ├── pages/
│   │   ├── [...slug].astro      Dynamic case-study renderer
│   │   ├── index.astro          Directory page (grid of all studies)
│   │   ├── admin/index.astro    Operator portal (noindex; PAT auth; no backend)
│   │   └── rss.xml.js           /rss.xml feed
│   ├── layouts/
│   │   └── CaseStudy.astro      Case-study layout (hero + metrics + body + CTA)
│   └── components/
│       ├── Hero.astro            Hero section renderer
│       ├── MetricsStrip.astro    Dollar raised / investors / time-to-fund strip
│       ├── Cta.astro             Pre-qualify CTA button (UTM-tagged href)
│       ├── Quote.astro           Optional founder quote block
│       ├── JsonLd.astro          Schema.org JSON-LD emitter (<head>)
│       ├── BaseHead.astro        <head> template (SEO, OG, fonts, noindex flag)
│       ├── SiteHeader.astro      Site header
│       └── SiteFooter.astro      Site footer
│
├── .github/
│   ├── workflows/
│   │   ├── detect.yml           Cron at 04:47 UTC + 11:23 UTC (two slots for
│   │   │                          redundancy; GitHub drops/delays schedule events
│   │   │                          during high-load periods)
│   │   ├── deploy.yml           Astro build + Pages deploy on push to main
│   │   ├── on-comment.yml       /funded slash command dispatcher
│   │   └── on-issue.yml         Issue Form dispatcher (routes by title prefix)
│   └── ISSUE_TEMPLATE/
│       ├── backfill.yml         Bulk-generate historical campaigns
│       ├── redraft-with-feedback.yml  Re-generate with operator feedback
│       └── config.yml           Disables blank issues (forces templates)
│
├── .state/
│   ├── detection-log.md         Daily cron heartbeat (one row per run; committed)
│   └── ratelimit.json           Today's generation counter (written per-run;
│                                 NOT committed back — see Known gaps below)
│
├── public/
│   ├── og/                      Hero/OG images, one per case study ({slug}.jpg)
│   └── CNAME                    funded.honeycombcredit.com
│
├── .env.example                 Environment variable template (copy to .env locally)
├── astro.config.mjs             Astro config (site URL, integrations, sitemap filter)
├── tailwind.config.mjs          Tailwind config (custom colors, fonts)
├── tsconfig.json                TypeScript strict mode + noUncheckedIndexedAccess
└── vitest.config.mts            Vitest config
```

---

## Data flow

```
PostHog HogQL
  (postgres.campaigns)
        │
        │  funded slugs ≥ 2026-01-01, newest first
        ▼
  scripts/detect.ts
        │
        │  filter out already-published (listAllCampaignSlugs)
        │  open GitHub tracking Issue per new slug
        │  consume rate-limit token
        ▼
  scripts/lib/pipeline.ts  ── used by generate, redraft, backfill, detect
        │
        ├─1─ scrape.ts
        │      invest.honeycombcredit.com/campaigns/{slug}
        │      parse __NEXT_DATA__ + HTML fallbacks → Campaign object
        │
        ├─2─ claude.ts
        │      system: prompts/case-study-prompt.md (with {{HUMANIZATION_*}} subs)
        │      user:   JSON InputPayload (campaign data)
        │      output: 14-key JSON → ClaudeOutputSchema validated
        │
        ├─3─ humanize.ts
        │      regex-based AI-tells validator
        │      fail → retry once with flagged issues as feedback
        │      second fail → publish anyway + humanization-warning label
        │
        ├─4─ image.ts
        │      fetch hero image URL from campaign → public/og/{slug}.jpg
        │
        ├─5─ mdx.ts
        │      write src/content/case-studies/{output-slug}.mdx
        │      frontmatter: 37 fields (Claude output + scraped metrics + dates)
        │      body: rich-text HTML story (allowlisted tags only)
        │      idempotency: keyed on campaignSlug, not output slug
        │
        └─6─ git.ts
               git add + git commit (bot identity when FUNDED_BOT_IDENTITY=1)
               caller pushes; detect.yml / on-comment.yml trigger deploy.yml
```

---

## Environment variables

| Variable | Required | Where used | Notes |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes (generation) | `scripts/lib/claude.ts` | Repo secret in CI |
| `GITHUB_TOKEN` | Yes (issue/comment ops) | `scripts/lib/github.ts` | Auto-provided in CI; set manually for local runs |
| `POSTHOG_API_KEY` | Yes (detection) | `scripts/lib/posthog.ts` | Personal API key, `project:query:read` scope |
| `POSTHOG_PROJECT_ID` | Yes (detection) | `scripts/lib/posthog.ts` | Numeric ID (39093 for Honeycomb Credit Production) |
| `POSTHOG_HOST` | No | `scripts/lib/posthog.ts` | Defaults to `https://us.posthog.com` |
| `CASE_STUDY_MODEL` | No | `scripts/lib/claude.ts` | Defaults to `claude-opus-4-7`; override for A/B |
| `FUNDED_BOT_IDENTITY` | No | `scripts/lib/git.ts` | Set to `'1'` in CI to commit as bot identity |
| `GITHUB_REPOSITORY` | Auto in CI | `scripts/lib/github.ts` | `owner/repo` format; set explicitly in workflow env |

Copy `.env.example` to `.env` for local development. The `.env` file is gitignored.

---

## Commands

```bash
# Site
npm run dev          # Local Astro dev server → http://localhost:4321
npm run build        # Static build → dist/
npm run typecheck    # astro sync && tsc --noEmit (same gate as CI)
npm test             # vitest run (65 tests)
npm run test:watch   # vitest watch mode

# Agent CLIs (needs ANTHROPIC_API_KEY + GITHUB_TOKEN in env)
npm run inspect  -- <campaign-slug>          # Diagnostic scrape, no cost, no commits
npm run generate -- <campaign-slug>          # Full pipeline, ~$0.45 spend
npm run redraft  -- <case-study-slug> --feedback="..."
npm run delete   -- <case-study-slug>
npm run backfill -- --slugs="slug-a\nslug-b" [--force] [--dry-run] [--rate=N]
npm run detect   -- [--dry-run]              # Cron entry point

# Status utilities (no API cost)
npx tsx scripts/status.ts                    # Today's rate-limit counter
npx tsx scripts/cost-estimate.ts             # Per-generation cost estimate
```

---

## Three operator interfaces (all converge on the same pipeline)

| Interface | URL / entry point | Auth |
|---|---|---|
| **Operator portal** | https://funded.honeycombcredit.com/admin | GitHub PAT (Issues: read+write) stored in browser localStorage |
| **Slash commands** | `/funded generate\|redraft\|delete\|status\|cost-estimate\|inspect <slug>` in any issue/PR comment | `author_association` must be `OWNER`, `COLLABORATOR`, or `MEMBER` |
| **Issue Forms** | GitHub Issues → New → "Backfill case studies" or "Redraft with feedback" | Same collaborator check via on-issue.yml |

All three create or update a tracking GitHub Issue. The audit log is the Issues tab.

---

## Three Zod schema boundaries

| File | What it validates | Failure mode |
|---|---|---|
| `src/content/config.ts` | MDX frontmatter at Astro build time | Build fails; deploy doesn't ship |
| `scripts/lib/schemas.ts` `ClaudeOutputSchema` | Claude's 14-key JSON response | Generation fails; tracking issue gets `error` label |
| `scripts/lib/schemas.ts` `CampaignSchema` | Scraped campaign payload (defensive) | Scrape fails; tracking issue gets `error` label |

When `invest.honeycombcredit.com` changes its `__NEXT_DATA__` shape, `CampaignSchema` is
what catches it. Fields the agent doesn't use are marked `.optional()` and `.passthrough()`
so minor shape changes don't break existing deployments.

---

## Claude output contract

The 14 keys Claude must return (per `prompts/case-study-prompt.md` §4,
validated by `ClaudeOutputSchema` in `scripts/lib/schemas.ts`):

| Key | Type / constraints | Notes |
|---|---|---|
| `h1Heading` | string, ≥20 chars | 6–14 words per prompt spec |
| `heroSubhead` | string, ≥20 chars | 8–16 words |
| `storyHeading` | string, ≥4 chars | 4–10 words |
| `story` | string (HTML), ≥2000 chars | 800–1200 words rich-text; allowlisted tags only |
| `heroImageAlt` | string, 8–200 chars | Descriptive alt text for hero/OG image |
| `metaTitle` | string, 40–70 chars | SEO title |
| `metaDescription` | string, 120–180 chars | SEO description |
| `ogTitle` | string, 30–80 chars | OG title (may differ from metaTitle) |
| `ogDescription` | string, 60–160 chars | OG description |
| `ctaText` | string, ≥3 chars | Label for the pre-qualify CTA button |
| `slug` | string, `^[a-z0-9-]+$` | URL-friendly; Claude chooses; MDX filename |
| `niche` | string, 2–80 chars | Fine-grained business category |
| `industry` | enum (12 values) | Controlled vocab; see `INDUSTRIES` in schemas.ts |
| `systemSchemaJson` | string \| object \| array | JSON-LD (LocalBusiness + Article); validated by `isValidJsonLd()` |

The `story` HTML body is extracted from the MDX file; all other keys map directly
to frontmatter fields in `src/content/config.ts`.

---

## MDX frontmatter fields

`src/content/config.ts` defines 37 frontmatter fields (Claude output + scraped metrics +
agent-derived values). Key groups:

- **Identity**: `businessName`, `niche`, `industry`, `city`, `state`
- **Headings**: `h1Heading`, `heroSubhead`, `storyHeading`
- **Images**: `heroImage` (`/og/{slug}.jpg`), `heroImageAlt`, `ogImage`
- **Metrics**: `amountRaised`, `amountRaisedFormatted`, `goalAmount`, `goalAmountFormatted`, `percentOfGoal`, `percentOfGoalFormatted`, `investorCount`, `timeToFund`
- **SEO**: `metaTitle`, `metaDescription`, `ogTitle`, `ogDescription`, `canonicalOverride?`
- **CTA**: `ctaText`
- **Source**: `campaignUrl`, `campaignId`, `campaignSlug`
- **Dates**: `publishedDate`
- **Schema.org**: `systemSchemaJson`
- **Optional founder quote**: `quote?`, `quoteAttribution?`

The `ctaUrl` field was removed in v4.0.x — the pre-qualify URL is a constant built
at render time in `src/components/Cta.astro` from `campaignSlug`.

---

## Rate limiting

**File:** `.state/ratelimit.json` — shape: `{ "date": "2026-06-04", "used": 1 }`

- Default cap: **1 generation/day** across all triggers (cron + manual + portal)
- Backfill override: up to **10/day** for a single backfill run (`--rate=N` flag)
- Hard cap on the override: 10 (enforced in `ratelimit.ts`)
- Day boundary: UTC midnight (00:00 UTC); counter auto-resets on first check of new day
- **Known gap**: the workflows don't commit `.state/ratelimit.json` back to the repo,
  so each workflow invocation starts with a fresh 0-of-N budget. In practice this
  hasn't caused overspend but the "1/day across all triggers" semantic is softer than
  documented. Fix: include `ratelimit.json` in per-slug commits in `pipeline.ts`.

---

## Humanization validation

`scripts/lib/humanize.ts` + `scripts/lib/humanization-rules.ts`

The validator runs after every Claude response and checks the `story` field (and headings)
for AI-writing tells. Rules are defined once in `humanization-rules.ts` and referenced by
both the validator and the prompt (via `{{HUMANIZATION_*}}` placeholder substitutions) so
a rule change propagates automatically to both surfaces.

**Retry policy (defined in `pipeline.ts`):**
1. First failure → re-call Claude once with flagged issues injected as `redraftFeedback`
2. Second failure → publish anyway; tracking issue gets `humanization-warning` label
   (rationale: a hard gate left real funded campaigns unpublished, which is worse)

**Rule categories:** banned vocabulary, hedge phrases, "not just…but" pattern, tricolons
(density cap: ≤3 per 500 words), em-dashes (density cap: ≤3 per 500 words), blocked
openers (generic first-sentence patterns).

---

## Cron schedule

`detect.yml` runs on **two daily slots** because GitHub Actions silently drops or delays
scheduled workflows during high-load periods:

| Slot | UTC time | Local (EDT) | Rationale |
|---|---|---|---|
| Primary | 04:47 UTC | 00:47 EDT | Overnight; low GitHub contention |
| Backup | 11:23 UTC | 07:23 EDT | Mid-morning; off :00/:30 traffic spikes |

The script is fully idempotent — already-published campaigns are filtered before any
rate-limit consumption, so running twice on the same day is free when the first run succeeds.

---

## Cost model

| Operation | Cost |
|---|---|
| Generate or redraft | ~$0.45 (Opus 4.7; ~17K input + ~2.7K output tokens) |
| Retry path (humanization fail) | ~$0.90 (2× Claude calls) |
| Inspect / delete / status / cost-estimate | $0 |
| Astro build + Pages deploy | $0 (GitHub Actions free tier) |
| Steady state (~10 funded campaigns/month) | ~$5/month |

Pricing constants live in `scripts/lib/claude.ts` in the `PRICING` map. Update them when
switching models or when Anthropic changes published pricing.

---

## How to extend this system

### Add a new field to Claude output

1. Add the field to `ClaudeOutputSchema` in `scripts/lib/schemas.ts`
2. Add the corresponding frontmatter field to the schema in `src/content/config.ts`
3. Update the prompt in `prompts/case-study-prompt.md` (§4 output schema + §15 example)
4. Wire the field into `scripts/lib/mdx.ts` (`writeCaseStudy()` frontmatter assembly)
5. Use the field in the relevant Astro component/layout

### Add a new slash command

1. Add the command handler to `scripts/dispatch-comment.ts` (`switch` block)
2. Create the backing CLI script in `scripts/`
3. Update the comment in `dispatch-comment.ts` header listing supported commands
4. Update the README operator portal section listing supported commands

### Add a new humanization rule

1. Add the rule to `scripts/lib/humanization-rules.ts`
2. If the rule needs a prompt `{{placeholder}}`, add it to `applyPromptSubstitutions()`
   in `humanization-rules.ts` and add the `{{HUMANIZATION_*}}` tag to the prompt
3. Add a unit test in `scripts/lib/humanize.test.ts`

### Add a new industry to the controlled vocabulary

1. Add the string to `INDUSTRIES` in `src/content/config.ts` (additive only; never rename)
2. Mirror the change in `INDUSTRIES` in `scripts/lib/schemas.ts`
3. Update §8 of `prompts/case-study-prompt.md`

---

## Key invariants and conventions

- **`campaignSlug` vs output `slug`**: `campaignSlug` is the Honeycomb platform identifier
  (used for scraping and idempotency). `slug` is Claude's chosen URL slug (the MDX filename).
  These often differ. `mdx.ts` keys idempotency on `campaignSlug` so redrafts overwrite
  the correct file even if Claude returns a different slug.

- **`story` is the MDX body, not a frontmatter field.** Every other Claude output key
  maps to frontmatter. `story` is written as the document body below the YAML fence.

- **HTML allowlist in `story`**: only `<p>`, `<h2>`, `<a>`, `<strong>`, `<em>`, `<ul>`,
  `<ol>`, `<li>` are permitted. Blocked tags (`<div>`, `<img>`, `<script>`, etc.) are
  stripped before writing. Enforced in `scripts/lib/mdx.ts`.

- **Bot identity**: when `FUNDED_BOT_IDENTITY=1` (set by all CI workflows), commits use
  the identity `Claude <noreply@anthropic.com>`. Local runs omit this var and commit as
  the current git user.

- **INDUSTRIES enum is additive only.** Renaming a value would orphan existing MDX files
  that use the old name (Astro build would fail on those files).

- **No imports across the src/scripts boundary.** `scripts/lib/schemas.ts` duplicates the
  `INDUSTRIES` array from `src/content/config.ts` rather than importing it, keeping the
  CLI surface independent of the Astro build runtime.

- **Strict TypeScript**: `tsconfig.json` enables `noUncheckedIndexedAccess`. Array/object
  index access returns `T | undefined`. Handle the undefined case or use `!` with a comment.

- **`deploy.yml` serializes builds** via `concurrency: { group: pages, cancel-in-progress: false }`.
  Never change `cancel-in-progress` to `true` — it would abort in-flight deploys.

- **Pushes from `GITHUB_TOKEN` don't trigger downstream `push:` workflows** (GitHub's
  recursion safeguard). Both `detect.yml` and `on-comment.yml` explicitly dispatch
  `deploy.yml` via `gh workflow run` after a successful push.

---

## Known gaps

1. **Founder-level input data.** The scrape payload doesn't include founder name, photo,
   or verbatim Q&A. The "Ask The Founders" tab on each campaign page would unlock this and
   is the highest-value quality lever on the roadmap. See `prompts/case-study-prompt.md` §6
   for how the prompt compensates today.

2. **Rate-limit state not persisted across workflow runs.** `.state/ratelimit.json` is
   written per-run but not committed, so each workflow invocation sees a fresh 0-of-N
   budget. The fix is small (include `ratelimit.json` in per-slug commits in `pipeline.ts`)
   but has race-condition implications if multiple workflows overlap.

3. **Pre-2026 historical campaigns are cron-skipped.** The PostHog query floors at
   `campaignexpirationdate >= '2026-01-01'`. ~570 historical funded campaigns are visible
   but intentionally skipped by the cron — operators use the Backfill Issue Form to
   hand-pick any they want published.

4. **Prompt version is not stored in MDX frontmatter.** There's no way to tell from a
   published case study which prompt version generated it. A `promptVersion` frontmatter
   field would make redraft targeting easier.
