# Case Study Generator — Collateral Development Agent v4.0

## What this is

A GitHub-native autonomous agent that publishes a case study for every funded
Honeycomb Credit campaign. The **repo is the agent**: GitHub Actions drives
detection and generation, operators interact through a web portal and GitHub
Issues, and the case studies live as MDX files committed directly to this repo.

**Live site:** https://funded.honeycombcredit.com  
**Operator portal:** https://funded.honeycombcredit.com/admin  
**Audit log:** https://github.com/tylerhoneycomb/case-study-generator/issues

---

## Quick commands

```bash
nvm use              # Node 20+ (from .nvmrc)
npm install
npm run dev          # Astro dev server — http://localhost:4321
npm run typecheck    # astro sync && tsc --noEmit
npm test             # vitest run (57 tests across 4 files)
npm run build        # static output → dist/
```

Agent CLIs (require `ANTHROPIC_API_KEY` + `GITHUB_TOKEN` in env):

```bash
npx tsx scripts/inspect.ts <honeycomb-slug>                  # diagnostic, $0
npx tsx scripts/generate.ts <honeycomb-slug>                 # ~$0.45
npx tsx scripts/redraft.ts <case-study-slug> --feedback="…"  # ~$0.45
npx tsx scripts/delete.ts <case-study-slug>                  # $0
npx tsx scripts/backfill.ts --slugs="A\nB\nC" [--force] [--dry-run] [--rate=N]
npx tsx scripts/detect.ts [--dry-run]                        # cron entry point
npx tsx scripts/status.ts                                    # rate-limit status
npx tsx scripts/cost-estimate.ts <slug> [<slug>…]            # cost estimate, $0
```

The distinction between **Honeycomb campaign slug** (e.g. `The-Saucy-African`)
and **case-study slug** (e.g. `saucy-african-west-african-simmer-sauces`) is
critical. `generate`/`detect`/`inspect` take campaign slugs; `redraft`/`delete`
take case-study slugs.

---

## Stack

| Layer | Technology |
|---|---|
| Site | Astro 5 + MDX content collections + Tailwind CSS |
| Type system | TypeScript (strict, `noUncheckedIndexedAccess`) |
| Hosting | GitHub Pages from a private repo (GitHub Pro) |
| AI generation | Anthropic SDK — `claude-opus-4-7` (~$0.45 per case study) |
| Testing | Vitest |
| Automation | GitHub Actions (4 workflows) |

---

## Architecture

```
invest.honeycombcredit.com  (__NEXT_DATA__ JSON scrape)
     ↓ scripts/lib/scrape.ts
Campaign + pageProps
     ↓ scripts/lib/pipeline.ts  (shared by generate / redraft / backfill)
     ├─ scripts/lib/claude.ts     ← Anthropic SDK, prompts/case-study-prompt.md
     │     ↓ ClaudeOutputSchema validation (scripts/lib/schemas.ts)
     ├─ scripts/lib/humanize.ts   ← AI-tell regex validator
     ├─ scripts/lib/image.ts      ← fetch hero image → public/og/{slug}.{ext}
     └─ scripts/lib/mdx.ts        ← write src/content/case-studies/{slug}.mdx
          ↓ git add + commit
          ↓ git push to main
          ↓ deploy.yml → GitHub Pages (~2 min to live)
```

### Workflow triggers

| Workflow | File | Trigger | What it does |
|---|---|---|---|
| **Detect** | `detect.yml` | Daily 12:07 UTC / manual | Scrapes listing, detects newly funded campaigns, runs pipeline |
| **On Comment** | `on-comment.yml` | Issue/PR comment starting with `/funded ` | Parses slash command, runs matching CLI |
| **On Issue** | `on-issue.yml` | Issue opened/edited/labeled | Routes `[Backfill]` and `[Redraft]` issue form submissions |
| **Deploy** | `deploy.yml` | Push to `main` / manual | typecheck → test → `astro build` → GitHub Pages |

---

## Data contracts

### Three Zod schema boundaries

Every piece of data crosses three explicit validation boundaries. Each is a
hard gate — failure stops the pipeline, logs the error, and labels the tracking
issue `error`.

| File | Validates | Failure mode |
|---|---|---|
| `src/content/config.ts` | MDX frontmatter at build time | Astro build fails; deploy is blocked |
| `scripts/lib/schemas.ts` `ClaudeOutputSchema` | Claude's 14-key JSON response | Generation fails; pipeline throws `PipelineError('claude', …)` |
| `scripts/lib/schemas.ts` `CampaignSchema` | Scraped `__NEXT_DATA__` payload | Scrape fails; pipeline throws `PipelineError('scrape', …)` |

### The 14 Claude output keys

Defined in `ClaudeOutputSchema` (`scripts/lib/schemas.ts`) and documented in
`prompts/case-study-prompt.md` Section 4:

```
h1Heading      heroSubhead      storyHeading
story          heroImageAlt     metaTitle
metaDescription  ogTitle        ogDescription
ctaText        slug             niche
industry       systemSchemaJson
```

`story` becomes the MDX body; all others map to frontmatter fields.
`slug` is the case-study filename/URL slug — distinct from the Honeycomb
campaign slug.

### Input payload sent to Claude

Built in `scripts/lib/pipeline.ts`, formatted by `scripts/lib/claude.ts`
`formatUserMessage()`. Exact shape (matching `InputPayload` interface):

```typescript
{
  campaignName: string,
  campaignSlug: string,          // Honeycomb platform slug — NOT the output slug
  campaignId: string,
  todayISO: string,              // "2026-04-24" — for datePublished in schema.org
  city: string,
  state: string,                 // uppercase 2-letter abbreviation
  totalFundsRaised: number,
  campaignTargetAmount: number,
  numInvestors: number,
  campaignStartDate: string,     // ISO date
  campaignExpirationDate: string,// ISO date
  summary: string,               // HTML from campaign page
  useOfProceeds?: string,        // optional
  issuerWebsite?: string,        // optional, URL
  issuerDescription?: string,    // optional, short business description
  ogImageUrl?: string,           // optional, hero/OG image URL
  redraftFeedback?: string,      // redraft only — operator-supplied feedback
}
```

### Content-collection frontmatter schema

Defined in `src/content/config.ts` with Zod. Key fields (all required unless
marked optional):

| Field | Type | Source |
|---|---|---|
| `businessName` | string | `campaignName` from scrape |
| `niche` | string (2–80 chars) | Claude |
| `industry` | enum (12 values) | Claude |
| `city`, `state` | string | Scrape |
| `h1Heading`, `heroSubhead`, `storyHeading` | string | Claude |
| `heroImage`, `ogImage` | `/og/{slug}.{ext}` path | `image.ts` |
| `heroImageAlt` | string | Claude |
| `amountRaised`, `goalAmount` | integer | Scrape (Math.rounded) |
| `*Formatted` fields | string | `format.ts` helpers |
| `percentOfGoal`, `investorCount` | integer | Derived |
| `timeToFund` | string | `formatTimeToFund()` |
| `metaTitle`, `metaDescription`, `ogTitle`, `ogDescription` | string | Claude |
| `ctaText` | string | Claude |
| `campaignUrl`, `campaignId`, `campaignSlug` | string | Scrape |
| `publishedDate` | date | `todayISO()` |
| `systemSchemaJson` | object or array | Claude (JSON-LD) |
| `quote`, `quoteAttribution` | string | optional, not set by agent |
| `canonicalOverride` | URL | optional, not set by agent |

**Numeric values are `Math.round()`-ed before writing.** Honeycomb's API
can return float-imprecision values (e.g. `46841.50001525879`). Without
rounding, Astro's `.int()` validation fails and the build never ships.

---

## Industry controlled vocabulary

Defined in both `src/content/config.ts` and `scripts/lib/schemas.ts`
(duplicated intentionally so CLIs don't import from Astro's build runtime).
The 12 valid values (additive-only — never rename):

```
Food & Beverage  |  Retail  |  Health & Wellness  |  Personal Services
Professional Services  |  Arts & Entertainment  |  Manufacturing & Craft
Agriculture  |  Hospitality  |  Technology  |  Education  |  Other
```

---

## Operator surfaces

### Web portal `/admin`

Static GitHub Pages page with no backend. On load it prompts for a GitHub
Personal Access Token (fine-grained, `issues: write` on this repo), stores it
in `localStorage`, and uses it to call the GitHub API directly. Each action
opens a tracking issue and posts the matching `/funded` slash command as a
comment — the `on-comment.yml` workflow handles the rest.

Auth boundary: the PAT is scoped to `issues: write`; the workflow enforces
collaborator status via `author_association`.

### Slash commands (`on-comment.yml`)

Posted in any GitHub issue or PR comment. Auth: `author_association` must be
`OWNER`, `COLLABORATOR`, or `MEMBER`.

| Command | Script | Effect |
|---|---|---|
| `/funded generate <honeycomb-slug>` | `generate.ts` | Full pipeline |
| `/funded redraft <case-study-slug> [feedback…]` | `redraft.ts` | Regenerate with optional feedback |
| `/funded delete <case-study-slug>` | `delete.ts` | Remove MDX + image + commit |
| `/funded status` | `status.ts` | Rate-limit status reply |
| `/funded cost-estimate <slug…>` | `cost-estimate.ts` | Cost estimate, no spend |
| `/funded inspect <honeycomb-slug>` | `inspect.ts` | `__NEXT_DATA__` diagnostic, no spend |

### Issue Forms

Located in `.github/ISSUE_TEMPLATE/`. Two forms:
- **`backfill.yml`** — `[Backfill] …` title prefix; routes to `backfill.ts`
- **`redraft-with-feedback.yml`** — `[Redraft] …` title prefix; routes to
  `redraft.ts` with multi-paragraph feedback

Routing is by title prefix, not label (labels can be silently dropped by
GitHub when they don't yet exist in the repo).

---

## Rate limiting

**Default cap: 3 generations per UTC day** across all triggers. Backfill can
override up to 10/day via the "Rate override" field.

State file: `.state/ratelimit.json` — shape `{"date":"2026-04-28","used":2}`.

**Known gap:** `consume()` writes the state file but workflows do not commit it
back to the repo. Each workflow run starts with a fresh counter from disk (which
was just checked out from the repo, so it reflects the last committed state,
not intra-day usage). See README "Known gaps" for details.

---

## GitHub Issues as audit log

Every generation attempt opens a tracking issue. The `stage()` function in
`scripts/lib/log.ts` posts progress as comments on that issue when
`setTrackingIssue(N)` has been called.

Labels used:

| Label | Meaning |
|---|---|
| `detection` | Auto-opened by cron |
| `published` | Pipeline completed successfully |
| `error` | Pipeline failed at any stage |
| `needs-review` | Humanization validator flagged issues |
| `queued` | Rate limit hit; will retry next day |
| `meta` | Daily summary issue |
| `dispatched` | Anti-replay guard on issue form submissions |

---

## Scraper (`scripts/lib/scrape.ts`)

Parses `__NEXT_DATA__` JSON embedded in Honeycomb campaign pages. No official
API exists. Two functions:

- `listListing()` → up to ~10 active Fundraising campaigns (the visible window)
- `fetchCampaign(slug)` → full campaign payload + `pageProps` blob + raw HTML

Hero image resolution is a 6-step priority chain in `extractHeroImageUrl()`:
1. `pageProps.ogImageUrl` — canonical top-level OG field (most stable)
2. `campaign.ogImageUrl` — v3.3 inner field
3. Top-level alternates (`heroImageUrl`, `coverImageUrl`, etc.)
4. `campaign.campaignMedia[]` array
5. Deep scan of entire `pageProps` blob (depth limit 8)
6. `<img src>` regex on raw HTML (last resort)

---

## Humanization validator (`scripts/lib/humanize.ts`)

Regex-based detector for common AI-writing patterns. Port of the original Wix
Velo backend validator.

Rules checked on `story` (plain text after HTML stripping):

| Rule type | What it catches | Threshold |
|---|---|---|
| `not_just_but` | "not just/only/merely X but Y" | First occurrence |
| `hedge_phrase` | "it's worth noting", "at the end of the day", etc. | First occurrence |
| `ai_vocab` | delve, tapestry, groundbreaking, revolutionize, etc. | First occurrence |
| `generic_opener` | "In today's…", "Imagine a…", etc. | First occurrence |
| `tricolon_list` | "A, B, and C" (1–3 words each) | > 2 per 500 words |
| `em_dash_overuse` | `—` | > 3 per 500 words |

Failures add `needs-review` to the tracking issue and post the issues list as
a comment. **Publication is not blocked** — the page ships regardless, but the
operator is notified.

---

## Prompt (`prompts/case-study-prompt.md`)

The system prompt sent to Claude on every generation. Sections:
1. Role
2. Target reader
3. Input schema (what the agent sends — see Input payload above)
4. Output schema (the 14 keys)
5. Voice rules
6. Narrative structure (five-beat arc)
6.7 Voice and rhythm rules (XML-tagged rule blocks with examples)
7. Hero section rules
8. Keyword tags and industry
9. Schema.org / JSON-LD rules
10. Slug rules
11. Rich-text HTML rules
12. Failure modes (AI patterns to avoid)
13. Grounding rule
14. Self-check checklist
15. Worked example (input + expected output)

Editing the prompt changes generation behavior. The `humanize.ts` rule list
must stay in sync with Section 12 of the prompt so Claude doesn't generate
patterns the validator will flag.

---

## Key implementation details

### Idempotency

`generate.ts` uses `findByCampaignSlug()` (walks all MDX frontmatter) to
detect duplicates by `campaignSlug`, not by the case-study filename. Running
`/funded generate <campaign>` twice is safe — the second run exits with a
warning unless `--force` is passed.

`redraft.ts` pins the output slug to the existing case-study slug via
`forcedOutputSlug` so regeneration overwrites in-place rather than creating a
sibling file at a slightly different slug.

### Numeric rounding

All monetary and count values are `Math.round()`-ed before writing to
frontmatter. Honeycomb's payload carries float-imprecision values (e.g.
`46841.50001525879`). The Astro content-collection schema enforces `.int()` on
these fields; without rounding the build fails.

### Bot identity

`scripts/lib/git.ts` `configureBotIdentity()` sets `user.name = funded-bot` /
`user.email = funded-bot@users.noreply.github.com` only when
`FUNDED_BOT_IDENTITY=1` is in the environment (set by all four workflows). This
keeps local developer commits under their own identity.

### Campaign stage detection

`isCampaignSuccessful()` in `scrape.ts` accepts two stages (case-insensitive):
`funded` and `successful - finalizing`. The latter is the post-close paperwork
window before a campaign formally flips to Funded; both should generate a case
study.

### Backfill slug parsing

`scripts/lib/parse-slugs.ts` defends against the Issue Form rendering quirk
where GitHub wraps `render: text` textarea content in a markdown code fence.
It strips fence delimiters, comment lines (`#`, `//`), and anything that
doesn't match the VALID_SLUG_RE (`^[A-Za-z0-9][A-Za-z0-9_-]*$`).

---

## File layout

```
src/
  content/
    case-studies/         ← one .mdx per funded campaign (agent writes here)
    config.ts             ← Zod schema; build-time frontmatter validation
  pages/
    [...slug].astro       ← case-study renderer
    index.astro           ← directory page
    admin/index.astro     ← operator portal (noindex, no backend)
    rss.xml.js            ← /rss.xml feed
  layouts/CaseStudy.astro ← hero + metrics strip + body + CTA
  components/             ← BaseHead, Hero, MetricsStrip, Quote, Cta,
                            JsonLd, SiteHeader, SiteFooter
  styles/global.css
public/
  og/                     ← hero / OG images, one per case study
  CNAME                   ← funded.honeycombcredit.com
scripts/
  generate.ts             ← /funded generate
  redraft.ts              ← /funded redraft
  delete.ts               ← /funded delete
  backfill.ts             ← [Backfill] issue form + /funded backfill
  detect.ts               ← daily cron entry point
  inspect.ts              ← /funded inspect (diagnostic)
  status.ts               ← /funded status
  cost-estimate.ts        ← /funded cost-estimate
  dispatch-comment.ts     ← on-comment.yml entry point
  dispatch-issue.ts       ← on-issue.yml entry point
  lib/
    pipeline.ts           ← shared per-slug pipeline
    claude.ts             ← Anthropic SDK wrapper + output validation
    scrape.ts             ← __NEXT_DATA__ + HTML extraction
    humanize.ts           ← AI-tell regex validator
    mdx.ts                ← MDX read/write
    image.ts              ← hero image fetch + store
    schemas.ts            ← ClaudeOutputSchema, CampaignSchema, INDUSTRIES
    github.ts             ← Octokit wrappers (createIssue, addComment, …)
    git.ts                ← git add/commit/push wrappers
    ratelimit.ts          ← .state/ratelimit.json ledger
    format.ts             ← formatMoney, formatPercent, formatTimeToFund
    parse-slugs.ts        ← backfill slug list parser
    log.ts                ← stage/info/warn/error + issue-comment sink
    args.ts               ← CLI argument parser
.github/
  workflows/
    deploy.yml            ← build + Pages deploy on push to main
    detect.yml            ← 12:07 UTC daily cron
    on-comment.yml        ← /funded slash dispatcher
    on-issue.yml          ← Issue Form dispatcher
  ISSUE_TEMPLATE/
    backfill.yml
    redraft-with-feedback.yml
    config.yml
.state/
  observed-fundraising.json  ← slug ledger (committed; updated by cron)
  detection-log.md           ← daily heartbeat log (committed by cron)
  ratelimit.json             ← intra-day counter (written but NOT committed)
prompts/
  case-study-prompt.md    ← runtime system prompt sent to Claude
```

---

## Test suite

57 tests across 4 files, run with `npm test` (vitest):

| File | Coverage |
|---|---|
| `scripts/lib/format.test.ts` | `formatMoney`, `formatPercent`, `formatTimeToFund`, `todayISO` |
| `scripts/lib/humanize.test.ts` | `validateCopy`, `stripHtml`, `formatIssuesForReviewer` |
| `scripts/lib/scrape.test.ts` | `extractNextData`, `extractHeroImageUrl`, `isCampaignSuccessful` |
| `scripts/lib/parse-slugs.test.ts` | `parseSlugs` — including the code-fence regression |

The deploy gate (`deploy.yml`) runs `npm run typecheck && npm test` before
every build. A failing test blocks the deploy.

---

## Environment variables

| Variable | Where supplied | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Repo secret (CI) / `.env` (local) | Claude API calls |
| `GITHUB_TOKEN` | Auto-provided by GitHub Actions (CI) / `.env` (local) | Issue/comment/label API |
| `GITHUB_REPOSITORY` | Set by all workflows | Octokit repo targeting (`owner/repo`) |
| `FUNDED_BOT_IDENTITY` | Set to `1` in all workflows | Activates `funded-bot` git identity |
| `CASE_STUDY_MODEL` | Optional override | Overrides `claude-opus-4-7` in `claude.ts` |

---

## Cost model

| Operation | Cost |
|---|---|
| Generate or redraft | ~$0.45 (Opus 4.7, ~17K input + ~2.8K output tokens) |
| Inspect / status / delete / cost-estimate | $0 |
| Astro build + Pages deploy | $0 (GitHub Actions minutes) |
| ~10 funded campaigns/month | ~$5/month |

Pricing reference in `scripts/lib/claude.ts` `PRICING` map. Update when
`DEFAULT_MODEL` changes.

---

## Known gaps

1. **Listing-window blind spot.** The cron scrapes ~10 currently-active
   Fundraising campaigns. Campaigns below the visible window are missed until
   manually backfilled via the portal.

2. **No founder input data.** The "Ask The Founders" Q&A tab on each campaign
   page is not scraped. It would be the single biggest quality improvement.

3. **Rate-limit persistence is per-run.** `.state/ratelimit.json` is written
   by `consume()` but not committed by the workflow, so each run starts at 0.
   In practice not a problem (cron runs once/day; backfill self-caps), but the
   documented "3/day across all triggers" guarantee is weaker than intended.
