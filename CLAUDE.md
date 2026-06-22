# CLAUDE.md — Collateral Development Agent v4.0

Technical specification for the `funded.honeycombcredit.com` case-study generation system. Written for an AI coding tool that needs to understand, maintain, or recreate the project from scratch.

---

## What this system does

This repo is an **autonomous content-generation agent** for Honeycomb Credit. It publishes a written case study for every funded community-lending campaign on the platform. The output site lives at [funded.honeycombcredit.com](https://funded.honeycombcredit.com).

The **repo itself is the agent**: GitHub Actions runs the detection cron, operators drive ad-hoc actions through GitHub Issues and a web portal, and the generated case studies live as MDX files committed directly to this repo. There is no external backend, no separate database, and no deploy server — the entire system is GitHub + Anthropic API + Astro on GitHub Pages.

---

## Stack

| Layer | Technology |
|---|---|
| Static site | Astro 5, TypeScript (strict), Tailwind CSS, MDX content collections |
| Hosting | GitHub Pages (custom domain `funded.honeycombcredit.com` via `public/CNAME`) |
| Automation | GitHub Actions (4 workflows) |
| AI generation | Anthropic SDK, `claude-opus-4-7` by default (overridable via `CASE_STUDY_MODEL` env var) |
| Discovery | PostHog HogQL API (reads Fivetran-mirrored `postgres.campaigns` table) |
| Campaign data | Web scraping of `invest.honeycombcredit.com` (`__NEXT_DATA__` + HTML) |
| Tests | Vitest (65 tests across 5 files) |
| Node | 20+ (`.nvmrc` pins version) |

---

## Directory structure

```
/
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── config.yml                    # Disables blank issues; sets contact links
│   │   ├── backfill.yml                  # Issue Form: batch historical generation
│   │   └── redraft-with-feedback.yml     # Issue Form: regenerate with operator feedback
│   └── workflows/
│       ├── deploy.yml                    # Astro build + GitHub Pages deploy (on push to main)
│       ├── detect.yml                    # Daily cron discovery + generation (PAUSED 2026-06-09)
│       ├── on-comment.yml                # Slash command dispatcher (/funded …)
│       └── on-issue.yml                  # Issue Form router (Backfill / Redraft)
├── .state/
│   ├── detection-log.md                  # Cron audit trail (one row per run)
│   └── .gitkeep
├── prompts/
│   └── case-study-prompt.md              # ~1000-line Claude instruction document
├── public/
│   ├── og/                               # Hero/OG images, one per case study
│   ├── CNAME                             # funded.honeycombcredit.com
│   └── .gitkeep
├── scripts/
│   ├── generate.ts                       # CLI: generate one case study
│   ├── redraft.ts                        # CLI: regenerate with feedback
│   ├── delete.ts                         # CLI: remove a published case study
│   ├── detect.ts                         # CLI: cron entry point (discovery + batch generation)
│   ├── backfill.ts                       # CLI: batch historical campaigns
│   ├── inspect.ts                        # CLI: diagnostic (no API spend, no commits)
│   ├── status.ts                         # CLI: query today's rate-limit consumption
│   ├── cost-estimate.ts                  # CLI: dry-run cost projection
│   ├── dispatch-comment.ts               # Routes /funded slash commands to correct script
│   ├── dispatch-issue.ts                 # Routes Issue Form submissions to correct script
│   └── lib/
│       ├── posthog.ts                    # HogQL client — queries funded campaigns
│       ├── scrape.ts                     # Fetch campaign detail from invest.honeycombcredit.com
│       ├── claude.ts                     # Anthropic SDK wrapper (generate + validate output)
│       ├── humanize.ts                   # AI-tells validator (post-Claude, pre-publish)
│       ├── humanization-rules.ts         # Banned words/phrases config (shared by validator + prompt)
│       ├── pipeline.ts                   # Shared 6-stage per-slug generation pipeline
│       ├── mdx.ts                        # MDX file I/O (read/write/delete, YAML frontmatter)
│       ├── image.ts                      # Fetch + store hero image to public/og/
│       ├── github.ts                     # Octokit wrappers (createIssue, addComment, addLabel…)
│       ├── git.ts                        # git add/commit/push helpers
│       ├── ratelimit.ts                  # Daily generation counter (1/day default, 10/day backfill)
│       ├── schemas.ts                    # Zod schemas: ClaudeOutputSchema, CampaignSchema
│       ├── log.ts                        # Structured logging (posts to tracking issue via `stage()`)
│       ├── format.ts                     # Money ($100K), date, time-to-fund formatting
│       ├── args.ts                       # CLI argument parsing
│       ├── parse-slugs.ts                # Backfill input parser (defends against code-fence drift)
│       ├── *.test.ts                     # Unit tests (5 files, 65 tests total)
│       └── .gitkeep
├── src/
│   ├── components/
│   │   ├── BaseHead.astro                # <meta> tags (title, description, OG, Twitter, canonical)
│   │   ├── SiteHeader.astro              # Navigation header
│   │   ├── SiteFooter.astro              # Footer
│   │   ├── Hero.astro                    # Hero section (H1, subhead, image, breadcrumb)
│   │   ├── MetricsStrip.astro            # 3-tile KPI bar: Raised / Investors / Time to fund
│   │   ├── Quote.astro                   # Optional founder quote block
│   │   ├── Cta.astro                     # Call-to-action button (UTM-tagged pre-qualify link)
│   │   ├── JsonLd.astro                  # JSON-LD <script> (LocalBusiness + Article schema.org)
│   │   └── .gitkeep
│   ├── layouts/
│   │   └── CaseStudy.astro               # Master layout: Hero → MetricsStrip → Story → Quote → CTA
│   ├── pages/
│   │   ├── index.astro                   # Directory page (grid of all case studies)
│   │   ├── [...slug].astro               # Dynamic case-study renderer
│   │   ├── rss.xml.js                    # RSS feed (/rss.xml)
│   │   └── admin/
│   │       └── index.astro               # Operator portal (noindex, PAT-auth in browser)
│   ├── content/
│   │   ├── config.ts                     # Astro content collection schema (Zod)
│   │   └── case-studies/                 # One .mdx per funded campaign (agent writes here)
│   └── styles/
│       └── global.css                    # Tailwind imports + font declarations
├── .env.example                          # Environment variable template
├── .nvmrc                                # Node 20
├── astro.config.mjs                      # Astro config (site URL, MDX, sitemap, Tailwind)
├── tailwind.config.mjs                   # Honeycomb brand tokens
├── tsconfig.json                         # TypeScript strict + noUncheckedIndexedAccess
├── vitest.config.mts                     # Vitest config (scripts/**/*.test.ts)
└── package.json                          # Version 4.0.0
```

---

## Local development

```bash
nvm use                                   # Node 20+
npm install
npm run dev                               # Astro dev server → http://localhost:4321
npm run build                             # Static output → dist/
npm run typecheck                         # astro sync && tsc --noEmit
npm test                                  # vitest run (65 tests)
```

The scripts below require `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` in environment. In CI both are injected as repo secrets.

```bash
npx tsx scripts/inspect.ts <slug>                          # Diagnostic; no API spend
npx tsx scripts/generate.ts <slug>                         # ~$0.45 spend
npx tsx scripts/redraft.ts <slug> --feedback="..."         # ~$0.45 spend
npx tsx scripts/delete.ts <slug>                           # $0
npx tsx scripts/backfill.ts --slugs="A\nB\nC" [--force] [--dry-run] [--rate=N]
npx tsx scripts/detect.ts [--dry-run]                      # Cron entry point
```

---

## Environment variables

```bash
ANTHROPIC_API_KEY=      # Required for generate/redraft/backfill/detect
GITHUB_TOKEN=           # Optional locally; auto-set in CI (secrets.GITHUB_TOKEN)
POSTHOG_API_KEY=        # Required for detect.ts (repo secret: POSTHOG_API_KEY)
POSTHOG_PROJECT_ID=     # Required for detect.ts (repo secret: POSTHOG_PROJECT_ID)
CASE_STUDY_MODEL=       # Optional; defaults to claude-opus-4-7
FUNDED_BOT_IDENTITY=    # Set to '1' in CI to suppress interactive prompts
```

---

## Generation pipeline (6 stages)

All generation paths (`generate.ts`, `redraft.ts`, `backfill.ts`, `detect.ts`) converge on `scripts/lib/pipeline.ts → runPipeline(opts)`.

```
Stage 1 — Scrape
  GET invest.honeycombcredit.com/campaigns/{slug}
  Extract __NEXT_DATA__ JSON blob + parse HTML for hero image fallbacks
  Validate with CampaignSchema (Zod); missing required fields = PipelineError

Stage 2 — Generate (Claude)
  Load prompts/case-study-prompt.md (substitute {{HUMANIZATION_*}} placeholders)
  Assemble InputPayload from campaign data + todayISO() + optional feedback
  POST to Anthropic API (claude-opus-4-7 or CASE_STUDY_MODEL override)
  Validate JSON response with ClaudeOutputSchema (Zod)

Stage 3 — Humanization validator
  Strip HTML from story, run validateCopy() against humanization-rules.ts
  Checks: banned vocabulary, hedge phrases, generic openers, em-dash density,
          tricolon density
  On failure: splice validator feedback into redraftFeedback, retry Stage 2 once
  On second failure: publish anyway, return humanizationWarnings in RunResult
  (Callers apply `humanization-warning` label to the tracking issue)

Stage 4 — Hero image
  extractHeroImageUrl() priority chain:
    1. pageProps.ogImageUrl  (canonical Honeycomb OG field)
    2. campaign.ogImageUrl
    3. top-level alternates (heroImageUrl, coverImageUrl, etc.)
    4. campaignMedia[] array
    5. deep-scan(pageProps) — catch-all
    6. HTML <img> regex    — last resort
  Save to public/og/{output-slug}.{ext}

Stage 5 — Write MDX
  Compose frontmatter object (all required fields from schema + Claude output)
  Write src/content/case-studies/{output-slug}.mdx
  Format: YAML frontmatter block + rich-text HTML body

Stage 6 — Commit
  git add {mdx-path} {image-path}
  git commit "feat(case-study): publish {campaignName} ({outputSlug})"
  (push happens outside runPipeline, in the calling script or workflow)
```

**Humanization retry policy**: `MAX_HUMANIZATION_ATTEMPTS = 2`. The first attempt is the primary generation; the second (if triggered) splices the validator's specific issue list into the Claude feedback. A hard gate was intentionally softened after empirical evidence showed real funded campaigns going unpublished (#39, #41). The model sees the validator as a hard gate (framing in prompt §13.5) — it is not aware of the system-level fallback.

**Idempotency**: de-duplication is on `campaignSlug` (the Honeycomb platform slug), not on the Claude-generated output slug. `findByCampaignSlug()` in `mdx.ts` walks all MDX frontmatter; a second run of `generate <slug>` skips if a matching `campaignSlug` field already exists.

---

## Content model

### Case study MDX structure

```
src/content/case-studies/{output-slug}.mdx
├── YAML frontmatter (validated by src/content/config.ts at Astro build time)
└── HTML body (rich-text; allowlisted tags only — see Prompt §11)
```

### Frontmatter fields (src/content/config.ts)

**Identity**
- `businessName: string` — display name of the business
- `niche: string` — 2–80 chars, e.g. "bone broth maker"
- `industry: enum` — one of 12 controlled values (see `INDUSTRIES` in config.ts; additive only, never rename)
- `city: string`
- `state: string` — 2-letter uppercase US abbreviation

**Headings** (Claude-authored)
- `h1Heading: string` — min 20 chars; should tease a tension or name an unusual mechanism; avoid dollar-led labels
- `heroSubhead: string` — min 20 chars
- `storyHeading: string` — min 4 chars; H2 opening the story body

**Images**
- `heroImage: string` — path `/og/{slug}.{jpg|png|webp|svg}`
- `heroImageAlt: string` — 8–200 chars; accessibility-focused description
- `ogImage: string` (optional) — usually same as heroImage

**Quote** (optional)
- `quote: string` — founder quote; layout hides block when absent
- `quoteAttribution: string` — paired with quote

**Metrics** (3 tiles in MetricsStrip)
- `amountRaised: number` — integer, nonnegative (rounded from float payload)
- `amountRaisedFormatted: string` — e.g. "$100K"
- `investorCount: number` — integer, nonnegative
- `timeToFund: string` — e.g. "21 days", "under a week"

**SEO** (Claude-authored)
- `metaTitle: string` — 40–70 chars
- `metaDescription: string` — 120–180 chars
- `ogTitle: string` — 30–80 chars
- `ogDescription: string` — 60–160 chars
- `canonicalOverride: string` (optional) — full URL

**CTA**
- `ctaText: string` — 3+ chars; e.g. "Fund your next kitchen"
- (No `ctaUrl` in frontmatter — `Cta.astro` builds UTM-tagged href from constant base + `campaignSlug`)

**Source traceability**
- `campaignUrl: string` — full URL to `invest.honeycombcredit.com/campaigns/{slug}`
- `campaignId: string`
- `campaignSlug: string` — the Honeycomb platform slug; used for idempotency checks

**Dates**
- `publishedDate: date` — coerced from ISO string

**Schema.org**
- `systemSchemaJson: array | object` — JSON-LD; Claude returns an array of 2 entities (LocalBusiness subtype + Article); also accepts `@graph` wrapper or single object

### HTML body

Rich-text HTML; allowlisted tags from prompt §11:
`<p>`, `<h2>`, `<h3>`, `<ul>`, `<ol>`, `<li>`, `<a>`, `<strong>`, `<em>`, `<blockquote>`

No `<div>`, `<img>`, `<script>`, `<style>`, or Markdown syntax. Target 800–1200 words. Single-sentence paragraphs are allowed. Narrative follows a 5-beat arc (see Prompt §6).

---

## Claude prompt architecture (prompts/case-study-prompt.md)

The prompt is ~1000 lines and is the single authoritative contract for what Claude must produce. It is loaded at runtime by `claude.ts`, with `{{HUMANIZATION_*}}` placeholders substituted from `humanization-rules.ts` — so the validator and prompt always share the same banned-word list.

**Prompt sections:**
1. Role & target reader
2. Input schema (the `InputPayload` type)
3. Output schema (14 JSON keys)
4. Voice rules (disruptive, approachable, trustworthy; person-centered narrative)
5. SEO & keyword rules (5–7 diverse tags: niche + location + specialty + use-of-proceeds + category)
6. Narrative 5-beat arc: Opening → Business & Stakes → Why Honeycomb → The Raise & Community → What the Money Did
7. Hero section rules
8. Industry controlled vocabulary (mirror of `INDUSTRIES` in config.ts)
9. Schema.org rules (LocalBusiness/subtype + Article)
10. Slug rules (kebab-case, business name + modifier)
11. Rich-text HTML allowlist
12. Humanization rules (substituted at runtime from `humanization-rules.ts`)
13. Self-check checklist (14 items)
14. Worked example (Brothmonger bone broth shop, end-to-end)

**Output keys Claude must return (JSON):**
`h1Heading`, `heroSubhead`, `storyHeading`, `story`, `slug`, `niche`, `industry`, `heroImageAlt`, `metaTitle`, `metaDescription`, `ogTitle`, `ogDescription`, `ctaText`, `systemSchemaJson`

All keys are validated by `ClaudeOutputSchema` in `scripts/lib/schemas.ts`.

---

## Validation layers (3 Zod schemas, in order)

| When | Schema | File | Validates | Failure |
|---|---|---|---|---|
| Generation | `CampaignSchema` | `scripts/lib/schemas.ts` | Scraped payload from invest.honeycombcredit.com | `PipelineError('scrape', …)` |
| Generation | `ClaudeOutputSchema` | `scripts/lib/schemas.ts` | Claude's 14-key JSON response | `PipelineError('claude', …)` |
| Astro build | Content collection schema | `src/content/config.ts` | MDX frontmatter at build time | Build fails; deploy blocked |

The third layer is the safety net: if a malformed MDX file ever reaches the repo, the `deploy.yml` build catches it before it reaches production.

---

## GitHub workflows

### deploy.yml — Build + deploy

**Triggers:** `push` to `main`; `workflow_dispatch`

**Steps:**
1. Checkout
2. Node 20 setup
3. `npm run typecheck` (`astro sync && tsc --noEmit`)
4. `npm test` (65 tests; failure blocks deploy)
5. `npm run build` → `dist/`
6. Upload artifact to GitHub Pages
7. Deploy to Pages (custom domain via `public/CNAME`)

Live within ~2 minutes of any push to main.

### detect.yml — Discovery + generation cron

**Status: PAUSED as of 2026-06-09** (Anthropic API spend paused while project is on hold).
Resume by uncommenting the `schedule:` block. `workflow_dispatch` remains active for manual triggers.

When active: two daily slots (04:47 UTC and 11:23 UTC) for redundancy against GitHub Actions scheduling delays.

**Steps:**
1. Checkout main (fetch-depth: 0)
2. Node 20 setup
3. `scripts/detect.ts [--dry-run]`
   - Queries PostHog: all campaigns where stage ∈ {Funded, Successful - Finalizing} AND expirationDate ≥ 2026-01-01, newest first
   - Filters already-published (via `listAllCampaignSlugs()`)
   - Rate-limit gate (1/day default); excess → `queued` label, deferred to next day
   - Opens tracking issue per eligible campaign
   - Calls `runPipeline()` per campaign
   - Appends row to `.state/detection-log.md`
4. `git push origin HEAD:main`
5. If new commits were pushed: `gh workflow run deploy.yml --ref main`

**Permissions required:** `contents: write`, `issues: write`, `actions: write`

### on-comment.yml — Slash command dispatcher

**Trigger:** Issue/PR comment body starts with `/funded `

**Auth gate:** `author_association ∈ {OWNER, COLLABORATOR, MEMBER}`

**Commands:**
```
/funded generate <campaign-slug>
/funded redraft <campaign-slug> [--feedback="..."]
/funded delete <case-study-slug>
/funded inspect <campaign-slug>
/funded status
/funded cost-estimate <slug> [<slug>…]
```

**Steps:**
1. React with 👀 emoji (receipt acknowledgment)
2. Checkout main
3. Node 20 setup
4. `scripts/dispatch-comment.ts` (parses command, routes to correct script)
5. Push commits (if content changed)
6. Dispatch `deploy.yml` if content was pushed

### on-issue.yml — Issue Form router

**Trigger:** Issue opened / edited / labeled (with routes by title prefix)

**Routes:**
- `[Backfill]` → `scripts/backfill.ts`
- `[Redraft]` → `scripts/redraft.ts`

**Anti-replay:** Adds `dispatched` label after first run; skips if already labeled (prevents re-trigger on edit).

---

## Operator interfaces

Three surfaces all converge on the same GitHub Issues audit log and the same `scripts/` CLI:

1. **Operator portal** — `https://funded.honeycombcredit.com/admin` (static page, PAT auth via browser localStorage, no backend). Posts `/funded` slash commands to a GitHub tracking issue. Noindex.
2. **Slash commands** — `/funded generate|redraft|delete|inspect|status|cost-estimate <slug>` in any issue/PR comment by a repo collaborator.
3. **Issue Forms** — GitHub Issues → New → "Backfill case studies" or "Redraft with feedback".

---

## Rate limiting

| Trigger | Daily limit |
|---|---|
| Default (cron, manual, portal) | 1 generation/day |
| Backfill Issue Form (with `--rate` override) | Up to 10/day |

Limit is shared across all triggers. Excess work gets a `queued` label; the cron drains queued issues before scanning for new ones on the next run.

**Known gap:** `.state/ratelimit.json` is written by `consume()` during a workflow run but not committed back to the repo. Each new workflow invocation starts with a fresh 0-of-1 budget. This hasn't caused meaningful over-spend in practice but the "1/day across all triggers" semantic is softer than intended.

---

## Cost model

| Operation | Cost |
|---|---|
| Generate or redraft | ~$0.45 (claude-opus-4-7, ~17K input + ~2.7K output tokens) |
| Inspect / delete / status | $0 |
| Astro build + GitHub Pages deploy | $0 (Actions free tier) |
| Steady state (~10 campaigns/month) | ~$5/month |

Override the model with `CASE_STUDY_MODEL=claude-opus-4-8` (or any valid model ID) to use a different tier. Cost estimate scales with model pricing.

---

## Brand tokens (Tailwind)

```
honeycomb-yellow: #FFDE17   (dominant accent)
honeycomb-cream:  #F6F3E5   (page background)
honeycomb-purple: #3F296B   (primary action color)
honeycomb-blue:   #D9ECFF   (light accent)
honeycomb-green:  #59B16B   (used sparingly)
honeycomb-ink:    #222222   (body text)
```

Fonts: Raleway (display/headlines), Open Sans (body). Both loaded from `@fontsource`.

---

## TypeScript conventions

- Strict mode + `noUncheckedIndexedAccess: true` + `noImplicitOverride: true`
- Path alias `~/` → `src/` (configured in `tsconfig.json`)
- All scripts run via `tsx` (not compiled); no build step for the CLI layer
- Zod schemas are the runtime source of truth; TypeScript types are derived from them
- `scripts/lib/*.test.ts` — Vitest unit tests; run with `npm test`

---

## Key design decisions

1. **Repo is the agent.** No external backend. GitHub Actions = cron + task runner. Issues = audit log. MDX files = database. PAT-auth portal = operator UI without a server.

2. **Discovery via PostHog, not listing scrape.** The invest.honeycombcredit.com campaign listing only shows ~10 active campaigns. PostHog mirrors the full `postgres.campaigns` table via Fivetran; a single HogQL query returns all funded campaigns (including ~570 historical ones).

3. **Humanization validator as AI-tells filter.** Post-Claude, pre-publish: `validateCopy()` scans for banned vocabulary, hedge phrases, generic openers, and structural patterns (tricolons, em-dashes) that signal AI-generated text. Retry-once-then-publish avoids indefinite blocking on marginal cases.

4. **Idempotency on `campaignSlug`, not output slug.** Claude can generate slightly different output slugs across runs (the model has some variation). Idempotency is matched on the stable `campaignSlug` field from the Honeycomb platform (stored in frontmatter), not on the file name.

5. **Three Zod validation layers.** (1) Scrape payload on ingestion; (2) Claude output before writing; (3) Astro content collection schema at build time. The build layer is the safety net that prevents a malformed case study from reaching production even if layers 1–2 somehow pass.

6. **Prompt and validator share the same config.** `humanization-rules.ts` exports constants used both by the validator (`humanize.ts`) and as prompt substitutions (`{{HUMANIZATION_*}}` in the prompt). Adding a banned phrase to the config file automatically updates both the generation instructions and the post-generation check.

7. **Metrics strip is 3 tiles.** As of 2026-06-09, the "% of goal" tile was removed. MetricsStrip shows: Raised / Investors / Time to fund. The four backing fields (`goalAmount`, `goalAmountFormatted`, `percentOfGoal`, `percentOfGoalFormatted`) were removed from the frontmatter schema and pipeline output. Existing case studies were migrated.

8. **GitHub Issues as unified audit log.** Every action (cron-detected, manual CLI, portal, slash command) opens a tracking issue. Status updates post as comments via `log.ts → stage()`. Labels track state (`queued`, `published`, `error`, `humanization-warning`, `dispatched`).

---

## Known gaps and roadmap

- **Founder-level input data.** The scrape payload does not include the founder's name, photo, or verbatim Q&A from the "Ask The Founders" campaign tab. Adding this is the single biggest remaining quality lever. See `prompts/case-study-prompt.md` §6 Beat 4 for how the prompt compensates today.
- **Rate-limit persistence.** `.state/ratelimit.json` is written per-run but not committed. Each workflow invocation starts fresh. Fix: commit the file in `pipeline.ts` alongside the MDX and image.
- **Pre-2026 campaigns not auto-detected.** PostHog query floors at `campaignexpirationdate >= '2026-01-01'`. ~570 historical campaigns exist but the cron skips them intentionally. Operators request these via the Backfill Issue Form.
- **Cron paused.** Daily schedule disabled 2026-06-09. Resume by uncommenting the `schedule:` block in `.github/workflows/detect.yml`.
