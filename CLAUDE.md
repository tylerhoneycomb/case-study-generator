# CLAUDE.md — Collateral Development Agent

> This file is the authoritative technical reference for AI coding tools working in this repository. It describes what the system does, how every component fits together, every contract between components, and every design decision that governs future changes.

---

## 1. What this repo is

**funded.honeycombcredit.com** is a static website that publishes a case study for every funded campaign on the [Honeycomb Credit](https://honeycombcredit.com) community-investment platform. The **repo itself is the agent**: GitHub Actions detects newly-funded campaigns, calls Claude to write each case study, commits the resulting MDX file and hero image, and deploys the updated site automatically.

A human operator never has to touch a file. Every action — automated or manual — is logged as a GitHub Issue.

---

## 2. Architecture overview

```
PostHog (Fivetran-mirrored postgres.campaigns)
    │
    │  fetchFundedCampaigns() — HogQL query, returns all
    │  Funded/Successful-Finalizing campaigns ≥ 2026-01-01
    ▼
detect.ts (scripts/detect.ts)
    │  Filters out already-published slugs.
    │  Respects rate limit (1/day default).
    │  Opens a tracking GitHub Issue per new campaign.
    ▼
pipeline.ts (scripts/lib/pipeline.ts)   ← shared by generate/redraft/backfill
    │
    ├─ scrape.ts         fetchCampaign(slug) → Campaign (from __NEXT_DATA__ JSON)
    ├─ claude.ts         generateCaseStudy(payload) → ClaudeOutput (14 keys)
    ├─ humanize.ts       validateCopy(storyText) → pass/fail + issues
    │                    Retry once on fail; publish-anyway after 2 attempts.
    ├─ image.ts          fetchAndStoreHeroImage() → public/og/{slug}.{ext}
    ├─ mdx.ts            writeCaseStudy() → src/content/case-studies/{slug}.mdx
    └─ git.ts            git add + commit (feat(case-study): publish …)
    │
    ▼
deploy.yml
    astro build → dist/   (typecheck + 65-test suite first)
    actions/deploy-pages → funded.honeycombcredit.com (~2 min after commit)
```

### Three trigger paths — all converge on the same pipeline

| Trigger | Entry point | Auth |
|---|---|---|
| Daily cron (04:47 UTC + 11:23 UTC) | `detect.ts` | repo secrets |
| `/funded <cmd>` slash in any issue/PR comment | `dispatch-comment.ts` → `on-comment.yml` | GitHub `author_association` (OWNER/COLLABORATOR/MEMBER) |
| Issue Form submission ([Backfill] or [Redraft]) | `dispatch-issue.ts` → `on-issue.yml` | same as above |
| Operator portal (`/admin`) | Browser JS opens issue + posts slash command | PAT stored in browser localStorage |

All four converge on the same `scripts/` CLI and the same Issues audit log.

---

## 3. Tech stack

| Layer | Technology |
|---|---|
| Site framework | **Astro 5** + MDX content collections |
| Styling | **Tailwind CSS 3** |
| Fonts | Open Sans (body), Raleway (display) |
| Hosting | **GitHub Pages** from a private repo (GitHub Pro) |
| CI/CD | **GitHub Actions** (deploy.yml, detect.yml, on-comment.yml, on-issue.yml) |
| AI generation | **Anthropic SDK** + Claude (model: `claude-opus-4-7` by default; override via `CASE_STUDY_MODEL` env var) |
| Discovery | **PostHog HogQL** querying a Fivetran-mirrored `postgres.campaigns` table |
| Content scraping | `invest.honeycombcredit.com` `__NEXT_DATA__` JSON blob |
| Schema validation | **Zod** (3 layers; see §9) |
| Testing | **Vitest** (65 tests) |
| Runtime | Node 20+ (`.nvmrc`), TypeScript strict (`noUncheckedIndexedAccess`) |

---

## 4. Repository layout

```
src/
  content/
    case-studies/         ← one .mdx per published campaign (agent writes here)
    config.ts             ← Zod schema; Astro content-collection contract
  pages/
    [...slug].astro       ← case-study renderer (dynamic route)
    index.astro           ← directory / listing page
    admin/index.astro     ← operator portal (noindex; static, no backend)
    rss.xml.js            ← /rss.xml feed
  layouts/
    CaseStudy.astro       ← hero + metrics strip + body + CTA
  components/
    BaseHead.astro        ← <head> (meta, OG, JSON-LD via JsonLd.astro)
    Hero.astro            ← H1 + subhead + hero image
    MetricsStrip.astro    ← raised / investors / time-to-fund chip row
    Quote.astro           ← optional founder quote block (hidden when empty)
    Cta.astro             ← pre-qualify CTA (UTM-tagged href built at render time)
    JsonLd.astro          ← injects systemSchemaJson as <script type="application/ld+json">
    SiteHeader.astro
    SiteFooter.astro
  styles/
    global.css

public/
  og/                     ← hero / OG images, one per case study ({slug}.{ext})
  CNAME                   ← funded.honeycombcredit.com

prompts/
  case-study-prompt.md    ← runtime system prompt sent to Claude on every generation

scripts/
  generate.ts             ← one-shot: scrape → Claude → humanize → image → MDX → commit
  redraft.ts              ← like generate but reads existing MDX for campaignSlug,
                            pins output slug to preserve the URL
  delete.ts               ← removes MDX + hero image, commits deletion
  backfill.ts             ← batch version of generate (from --slugs list); skips funded-check
  detect.ts               ← daily cron entry point (PostHog discovery → pipeline)
  inspect.ts              ← diagnostic: prints campaign payload, no spend, no commit
  status.ts               ← prints rate-limit state and last-cron mtime
  cost-estimate.ts        ← estimates Claude spend for a slug list (no API call)
  dispatch-comment.ts     ← parses /funded slash command, routes to correct script
  dispatch-issue.ts       ← parses Issue Form body, routes Backfill or Redraft

  lib/
    pipeline.ts           ← shared 6-stage pipeline (scrape/claude/humanize/image/mdx/commit)
    scrape.ts             ← invest.honeycombcredit.com __NEXT_DATA__ extractor
    claude.ts             ← Anthropic SDK wrapper; validates ClaudeOutput schema
    humanize.ts           ← AI-tells regex validator (post-generation gate)
    humanization-rules.ts ← single source of truth for banned phrases/vocab/openers
    posthog.ts            ← PostHog HogQL client for funded-campaign discovery
    ratelimit.ts          ← .state/ratelimit.json ledger (1/day default; 10/day max)
    mdx.ts                ← MDX read/write; idempotency by campaignSlug
    image.ts              ← hero image fetch + store under public/og/
    github.ts             ← Octokit wrappers (createIssue, addLabel, closeIssue, addComment)
    schemas.ts            ← Zod: ClaudeOutputSchema, CampaignSchema, ListingEntrySchema
    format.ts             ← formatMoney, formatPercent, formatTimeToFund, todayISO
    git.ts                ← git add / commit / push wrappers
    log.ts                ← stage() (posts to tracking issue), info(), warn(), error()
    args.ts               ← CLI arg parser
    parse-slugs.ts        ← backfill slug-list parser (strips comments, code fences)

.github/
  workflows/
    deploy.yml            ← typecheck + test + astro build + Pages deploy (on push to main)
    detect.yml            ← cron (04:47 UTC and 11:23 UTC daily) + workflow_dispatch
    on-comment.yml        ← /funded slash dispatcher (issue_comment trigger)
    on-issue.yml          ← Issue Form dispatcher (issues: opened/edited/labeled)
  ISSUE_TEMPLATE/
    backfill.yml          ← [Backfill] form (slug list + rate override)
    redraft-with-feedback.yml ← [Redraft] form (slug + feedback textarea)
    config.yml            ← disables blank issues

.state/
  detection-log.md        ← one row per cron run (appended; never overwritten)
  ratelimit.json          ← today's generation counter (written at runtime, not committed)
```

---

## 5. Data flows

### 5.1 Detection flow (daily cron)

1. `detect.ts` calls `fetchFundedCampaigns()` (PostHog HogQL).
2. Filters out slugs already published (`listAllCampaignSlugs()` reads all MDX frontmatter).
3. Iterates eligible candidates newest-first (by `campaignExpirationDate`).
4. Rate-limit check: if today's budget (`ratelimit.json`) is exhausted, remaining candidates are deferred — no issue opened, no error — logged in `detection-log.md` under `rate-limit deferred`.
5. For each candidate that passes the gate: opens a tracking GitHub Issue, then calls `runPipeline(slug)`.
6. On success: adds `published` label, closes the issue.
7. On failure: adds `error` label, leaves the issue open.
8. Appends a row to `.state/detection-log.md` (always, even on dry-run or zero-activity days).
9. Commits the log file (`chore(state): append detection log`).
10. Detection workflow pushes commits to main, then fires `deploy.yml` via `gh workflow run` (because GITHUB_TOKEN pushes don't trigger downstream `push:` workflows).

Deferred campaigns are not explicitly queued anywhere. The next cron run re-discovers them via PostHog (they're still un-published) and processes them.

### 5.2 Generation pipeline (`runPipeline`)

Six sequential stages, each surfaced as a comment on the tracking issue:

| Stage | What happens | Failure mode |
|---|---|---|
| 1 scrape | `fetchCampaign(slug)` — HTTP GET of invest.honeycombcredit.com/campaigns/{slug}, parse `__NEXT_DATA__` | `PipelineError('scrape', …)` |
| 2 precheck | Validate funded status (unless `skipFundedCheck`); check required fields (city/state/target/summary) | `PipelineError('precheck', …)` |
| 3 claude | `generateCaseStudy(payload)` — calls Claude API with runtime prompt, validates 14-key JSON output | `PipelineError('claude', …)` |
| 3b humanize | `validateCopy(storyText)` — regex validators for AI tells. Retry once with validator feedback. After 2 failures, publishes anyway with `humanization-warning` label. | Label only, no abort |
| 4 image | `fetchAndStoreHeroImage()` — resolves hero URL (6-step priority chain), downloads, saves to `public/og/{slug}.{ext}` | `PipelineError('image', …)` |
| 5 MDX | `writeCaseStudy()` — assembles frontmatter from scrape + Claude output, writes MDX | File-write error |
| 6 commit | `git add` + `git commit` | Git error |

### 5.3 Humanization retry policy

The pipeline calls Claude up to `MAX_HUMANIZATION_ATTEMPTS = 2` times:
- Attempt 1: normal generation.
- If humanization fails: attempt 2 with the validator's flagged issues injected into `redraftFeedback`.
- If attempt 2 also fails: publishes anyway, adds `humanization-warning` label to the tracking issue.

Rationale: a hard gate caused real funded campaigns to go unpublished permanently (#39, #41). Two-strikes-and-publish bounds cost (~2× per failure path) while giving the model a correction round.

The runtime prompt (`prompts/case-study-prompt.md §13.5`) still describes the validator as a hard gate — this is intentional framing to motivate compliance; the model should not know about the system-level fallback.

### 5.4 Hero image resolution (6-step priority)

`extractHeroImageUrl()` in `scrape.ts` walks these sources in order:
1. `pageProps.ogImageUrl` — canonical top-level OG field (most stable)
2. `campaign.ogImageUrl` — v3.3 spec inner field
3. Top-level alternates: `heroImageUrl`, `coverImageUrl`, `mainImageUrl`, `imageUrl`, `image`
4. `campaign.campaignMedia[]` — `url`, `imageUrl`, `src`, `href`, `fileUrl` keys
5. Deep-scan of entire `pageProps` blob (depth ≤ 8, URLs matching `storage.googleapis.com/honeycomb-uploads`)
6. HTML `<img>` regex fallback (anchored on Honeycomb storage host)

---

## 6. Schemas and contracts (three layers)

| Schema | Location | Validates | Failure mode |
|---|---|---|---|
| `CampaignSchema` | `scripts/lib/schemas.ts` | Scraped `__NEXT_DATA__` campaign payload | `ScrapeError` — pipeline aborts, tracking issue gets `error` label |
| `ClaudeOutputSchema` | `scripts/lib/schemas.ts` | Claude's 14-key JSON response | `ClaudeError` — pipeline aborts |
| Astro content collection | `src/content/config.ts` | MDX frontmatter at build time | Build fails — deploy never ships |

The 14 Claude output keys (defined in `prompts/case-study-prompt.md §4` and `ClaudeOutputSchema`):

`h1Heading`, `heroSubhead`, `storyHeading`, `story` (HTML), `heroImageAlt`, `metaTitle`, `metaDescription`, `ogTitle`, `ogDescription`, `ctaText`, `slug`, `niche`, `industry`, `systemSchemaJson`

These keys map 1:1 to MDX frontmatter fields (except `story`, which becomes the MDX body) and to `src/content/config.ts` schema fields.

### Industry controlled vocabulary (additive only — never rename)

`Food & Beverage`, `Retail`, `Health & Wellness`, `Personal Services`, `Professional Services`, `Arts & Entertainment`, `Manufacturing & Craft`, `Agriculture`, `Hospitality`, `Technology`, `Education`, `Other`

Defined in both `src/content/config.ts` and `scripts/lib/schemas.ts` (intentionally duplicated so scripts do not import from `src/`).

---

## 7. Humanization rules (AI-tell validator)

`scripts/lib/humanization-rules.ts` is the **single source of truth** for all banned patterns. Both the validator (`humanize.ts`) and the runtime prompt (`claude.ts` → prompt substitution) read from it. Adding a rule to this file propagates automatically to both.

### What the validator checks (on `story` and `metaDescription`)

| Check | Type | Threshold |
|---|---|---|
| "not just/only/merely/simply X but Y" constructions | banned phrase | zero occurrences |
| Hedge/filler phrases (`it's worth noting`, `when it comes to`, etc.) | banned phrase | zero occurrences |
| AI vocabulary (`delve`, `tapestry`, `groundbreaking`, `revolutionize`, etc.) | banned vocab | zero occurrences |
| Generic openers (`in today's`, `in the world of`, `imagine a`, etc.) | first-sentence check | zero occurrences |
| Em-dash density | density (per 500 words) | > 3 fails |
| Tricolon density ("A, B, and C" with 1–3-word items) | density (per 500 words) | > 2 fails |

---

## 8. Rate limit

File: `.state/ratelimit.json` shape: `{ "date": "2026-04-28", "used": 2 }`

- **Default cap**: 1 generation per UTC calendar day.
- **Backfill override**: up to 10/day (set via `--rate=N` flag or the Issue Form's "Rate override" field).
- **Reset**: UTC midnight — first read of a new day auto-resets the counter.
- **Known gap**: `ratelimit.json` is written at runtime but **not committed back**. Each new workflow invocation starts fresh. In practice this doesn't cause overspend (cron runs once; manual ops are infrequent; backfill self-caps) but the documented semantics are more permissive than the code enforces.

---

## 9. Environment variables / repo secrets

| Variable | Where set | Used by |
|---|---|---|
| `ANTHROPIC_API_KEY` | Repo secret | `scripts/lib/claude.ts` — Claude API calls |
| `GITHUB_TOKEN` | Auto-provided by Actions | `scripts/lib/github.ts` — Issues, labels, comments |
| `POSTHOG_API_KEY` | Repo secret | `scripts/lib/posthog.ts` — campaign discovery |
| `POSTHOG_PROJECT_ID` | Repo secret | `scripts/lib/posthog.ts` — numeric PostHog project ID |
| `POSTHOG_HOST` | Optional; defaults to `https://us.posthog.com` | `scripts/lib/posthog.ts` |
| `GITHUB_REPOSITORY` | Auto-provided by Actions | `scripts/lib/github.ts` — repo reference |
| `FUNDED_BOT_IDENTITY` | Set to `'1'` in workflows | `scripts/lib/log.ts` — suppresses stdout in CI |
| `CASE_STUDY_MODEL` | Optional override | `scripts/lib/claude.ts` — defaults to `claude-opus-4-7` |

Local development: copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY` and `GITHUB_TOKEN`.

---

## 10. GitHub Actions workflows

### deploy.yml
- **Trigger**: push to `main`, `workflow_dispatch`
- **Steps**: `npm ci` → `npm run typecheck` (astro sync + tsc --noEmit) → `npm test` (65-test Vitest suite) → `astro build` → deploy to GitHub Pages
- **Concurrency**: `group: pages`, `cancel-in-progress: false` (never cancels a deploy mid-flight)

### detect.yml
- **Trigger**: cron `47 4 * * *` (04:47 UTC) and `23 11 * * *` (11:23 UTC) + `workflow_dispatch` with optional `dry-run` input
- **Two-slot rationale**: GitHub Actions silently drops or delays scheduled runs during high-load periods. Two staggered off-peak slots provide reliability without double-spending (the idempotency check filters already-published campaigns).
- **Push + deploy**: detect commits state/content, then explicitly dispatches `deploy.yml` via `gh workflow run` (GITHUB_TOKEN pushes don't trigger downstream `push:` workflows).

### on-comment.yml
- **Trigger**: `issue_comment: [created]`
- **Auth gate**: `author_association ∈ {OWNER, COLLABORATOR, MEMBER}`
- **Acknowledgement**: posts a 👀 reaction immediately on receipt
- **Command format**: `/funded generate|redraft|delete|status|cost-estimate|inspect <slug>`
- **Entry point**: `scripts/dispatch-comment.ts`

### on-issue.yml
- **Trigger**: `issues: [opened, edited, labeled]`
- **Route key**: title prefix `[Backfill]` or `[Redraft]` (robust to GitHub label-drop bug)
- **Anti-replay**: adds `dispatched` label after first run; `if: !contains(labels, 'dispatched')` prevents re-fire on edits
- **Concurrency**: serialized per issue number (simultaneous opened+labeled triggers don't race)
- **Entry point**: `scripts/dispatch-issue.ts`

---

## 11. Operator surface

### Admin portal (`/admin`)
Static page on GitHub Pages. No backend. Browser JavaScript:
1. Holds a fine-grained GitHub PAT in `localStorage` (scoped to `issues:write` on this repo).
2. On form submit: creates a GitHub Issue, then posts the matching `/funded …` slash command as the first comment.
3. `on-comment.yml` workflow picks up the comment and runs the actual script.
4. Progress flows back into the same Issue; the portal links directly to it.

### Slash commands (`/funded …`)
Available in any issue or PR comment by a repo collaborator:

| Command | What it does | Cost |
|---|---|---|
| `/funded generate <campaign-slug>` | Generate case study from Honeycomb campaign slug | ~$0.45 |
| `/funded redraft <case-study-slug> [feedback]` | Regenerate with optional feedback; preserves URL | ~$0.45 |
| `/funded delete <case-study-slug>` | Remove MDX + image, commit deletion | $0 |
| `/funded inspect <campaign-slug>` | Print campaign payload; no commit | $0 |
| `/funded status` | Print rate-limit state and last-cron mtime | $0 |
| `/funded cost-estimate <slugs>` | Estimate Claude spend; no API call | $0 |

### Issue Forms
- **[Backfill]** (`backfill.yml`): paste slug list, optional force/dry-run, optional rate override (1–10/day).
- **[Redraft with feedback]** (`redraft-with-feedback.yml`): slug + feedback textarea.

### Important distinctions for redraft vs. generate
- `generate` takes a **Honeycomb campaign slug** (e.g. `The-Saucy-African` — the URL path on `invest.honeycombcredit.com/campaigns/`).
- `redraft` takes a **case-study slug** (e.g. `saucy-african-west-african-simmer-sauces` — the MDX filename / URL path on `funded.honeycombcredit.com/`).
- `redraft` pins the output slug to the input slug so the public URL remains stable.

---

## 12. Runtime prompt

`prompts/case-study-prompt.md` is loaded by `scripts/lib/claude.ts` on every generation. It contains `{{HUMANIZATION_*}}` placeholders that `applyPromptSubstitutions()` fills from `humanization-rules.ts` before the API call. The substituted values include the exact banned-phrase lists, so the model sees the same rules the validator enforces.

**Prompt version header** says "aligned with Collateral Agent spec v3.3" — this is the internal spec version number for the prompt, distinct from the package version (4.0.0). Do not conflate them.

Key prompt sections:
- §3: Input schema (what Claude receives)
- §4: Output schema (14 required keys)
- §5: Voice rules (do/don't)
- §6: Five-beat narrative structure (opening / business+stakes / why Honeycomb / raise+community / what the money did)
- §6.7: Voice/rhythm texture rules (specificity ladder, scaffolding, tricolons, etc.)
- §8: Industry controlled vocabulary + keyword tag rules
- §9: Schema.org JSON-LD rules (LocalBusiness + Article)
- §10: Slug rules
- §11: HTML allowlist for `story` field
- §12: Humanization failure modes (what the validator catches)
- §13: Grounding rule (no invented facts)
- §14: Self-check checklist
- §15: Worked example (Brothmonger — oversubscribed case)

---

## 13. MDX format

Each case study is an MDX file at `src/content/case-studies/{case-study-slug}.mdx`.

Structure:
```mdx
---
businessName: "Brothmonger"
niche: "bone broth and soup maker"
industry: "Food & Beverage"
city: "Brooklyn"
state: "NY"
h1Heading: "..."
heroSubhead: "..."
storyHeading: "..."
heroImage: "/og/brothmonger-brooklyn-bone-broth.png"
heroImageAlt: "..."
ogImage: "/og/brothmonger-brooklyn-bone-broth.png"
amountRaised: 100000
amountRaisedFormatted: "$100,000"
goalAmount: 75000
goalAmountFormatted: "$75,000"
percentOfGoal: 133
percentOfGoalFormatted: "133%"
investorCount: 117
timeToFund: "21 days"
metaTitle: "..."
metaDescription: "..."
ogTitle: "..."
ogDescription: "..."
ctaText: "Fund your next kitchen"
campaignUrl: "https://invest.honeycombcredit.com/campaigns/..."
campaignId: "..."
campaignSlug: "Brothmonger-Brooklyn-Bone-Broth"
publishedDate: 2026-04-24
systemSchemaJson: [{ "@context": "...", ... }]
---

<p>story body HTML here...</p>
```

`story` content is rendered as the MDX body (raw HTML). `systemSchemaJson` is a parsed JSON-LD array/object stored in frontmatter and emitted as `<script type="application/ld+json">` by `JsonLd.astro`.

**Important**: `campaignSlug` in frontmatter is the Honeycomb platform slug used by `redraft.ts` to re-discover the source campaign. Never remove or change this field.

---

## 14. Image storage

Hero/OG images are stored at `public/og/{case-study-slug}.{ext}`. The file extension is preserved from the source URL. The path is referenced from frontmatter as `heroImage` and `ogImage`.

`image.ts` `fetchAndStoreHeroImage()`:
1. Resolves the hero URL from the campaign via `extractHeroImageUrl()`.
2. Fetches the image (HTTP GET, User-Agent set).
3. Derives the local filename from the case-study slug + source extension.
4. Writes to `public/og/` using `fs.writeFile`.
5. Returns the public path (`/og/slug.ext`) for frontmatter.

---

## 15. Deploy gate

Every push to `main` triggers `deploy.yml` which runs:
1. `npm run typecheck` — `astro sync && tsc --noEmit`. Catches frontmatter schema violations at compile time.
2. `npm test` — 65-test Vitest suite (format, humanize, parse-slugs, posthog, scrape).
3. `npm run build` — Astro content-collection validation + static build.

Any failure blocks the deploy. An agent-generated MDX with malformed frontmatter cannot reach production.

---

## 16. Cost model

| Operation | Cost |
|---|---|
| Generate or redraft | ~$0.45 (Opus 4.7 at ~17K input + ~2.7K output tokens) |
| Inspect / delete / status / cost-estimate | $0 |
| Astro build + Pages deploy | $0 (GitHub Actions minutes) |
| Steady state (~10 funded campaigns/month) | ~$5/month |

Pricing table in `scripts/lib/claude.ts`: Opus 4.7 = $15/Mtok input, $75/Mtok output.

---

## 17. Known gaps

### Founder-level input data
The input payload (from the campaign page `__NEXT_DATA__`) includes `issuer.description` but not the founder's name, photo, or verbatim Q&A from the "Ask The Founders" tab. This tab data is the single biggest quality lever still on the roadmap. `prompts/case-study-prompt.md §6` documents what the prompt does to compensate (refers to "the owner" as a character even without a name).

### Rate-limit persistence is per-run
`consume()` writes `.state/ratelimit.json` but the workflows do not commit it back. Each new workflow invocation starts with a fresh 0-of-1 budget. In practice this hasn't caused overspend. Fix: add `ratelimit.json` to per-slug commits in `pipeline.ts`. Race condition to think through if multiple workflows overlap.

### Pre-2026 historical campaigns are not auto-published
The PostHog HogQL query floors at `campaignexpirationdate >= '2026-01-01'`. ~570 historical funded campaigns exist in PostHog but are intentionally skipped by the cron. Tyler hand-picks any he wants published via the Backfill Issue Form.

### No founder quote field in v1
`src/content/config.ts` defines `quote` and `quoteAttribution` frontmatter fields but they default to empty. The layout (`CaseStudy.astro`) hides the quote block when both fields are absent. The prompt instructs Claude never to fabricate quotes.

---

## 18. Local development

```bash
nvm use            # Node 20+
npm install
npm run dev        # Astro dev server → http://localhost:4321
npm run build      # static output to dist/
npm run typecheck  # astro sync && tsc --noEmit
npm test           # vitest run (65 tests)
```

Running the agent CLIs locally requires `ANTHROPIC_API_KEY` (and optionally `GITHUB_TOKEN`) in `.env`:

```bash
npx tsx scripts/inspect.ts <honeycomb-campaign-slug>      # diagnostic, no spend
npx tsx scripts/generate.ts <honeycomb-campaign-slug>     # ~$0.45 spend
npx tsx scripts/redraft.ts <case-study-slug> --feedback="..."
npx tsx scripts/delete.ts <case-study-slug>
npx tsx scripts/backfill.ts --slugs="slug-a\nslug-b" [--force] [--dry-run] [--rate=N]
npx tsx scripts/detect.ts [--dry-run]                     # cron entry point
npx tsx scripts/status.ts
npx tsx scripts/cost-estimate.ts <slug>
```

---

## 19. Invariants to preserve

1. **The `campaignSlug` frontmatter field must never be removed** — `redraft.ts` reads it to re-discover the source campaign.
2. **`ctaUrl` is intentionally absent from frontmatter** — `Cta.astro` builds the UTM-tagged pre-qualify href from a constant base + `campaignSlug` at render time. Do not add it back.
3. **The `INDUSTRIES` array in `src/content/config.ts` and `scripts/lib/schemas.ts` must stay in sync** — they're intentionally duplicated so scripts don't import from `src/`. Additive only (never rename; renaming orphans prior case studies).
4. **Numeric frontmatter fields (`amountRaised`, `goalAmount`, `investorCount`) must be integers** — the content schema uses `.int()`. The pipeline rounds all values with `Math.round()` before writing MDX to defend against JSON float imprecision in Honeycomb's payload.
5. **The operator portal (`/admin`) is a static page with no backend** — never add server-side logic to it. Browser JS dispatches all actions through the GitHub Issues API using the visitor's own PAT.
6. **GITHUB_TOKEN pushes from workflows don't trigger downstream `push:` workflows** — that's why `detect.yml` and `on-comment.yml` explicitly call `gh workflow run deploy.yml` after pushing content commits.
