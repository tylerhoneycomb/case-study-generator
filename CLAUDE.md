# CLAUDE.md — AI Context for case-study-generator

This file is the primary briefing for any AI agent working in this repository. Read it before touching any file.

---

## What this repo is

`funded.honeycombcredit.com` — a fully autonomous content pipeline that publishes a case study for every funded Honeycomb Credit campaign. The **repo itself is the agent**: GitHub Actions orchestrates everything, content lives as MDX files in `src/content/case-studies/`, and the site is served by GitHub Pages.

Live site: https://funded.honeycombcredit.com  
Operator portal: https://funded.honeycombcredit.com/admin  
Audit log: https://github.com/tylerhoneycomb/case-study-generator/issues

---

## Architecture in one pass

```
Trigger (cron / portal / slash command / issue form)
  → detect.ts or generate.ts / redraft.ts / backfill.ts
    → scripts/lib/pipeline.ts  (shared per-slug pipeline)
      1. scrape.ts        — fetch campaign data from invest.honeycombcredit.com (__NEXT_DATA__)
      2. claude.ts        — call Claude with prompts/case-study-prompt.md → ClaudeOutput JSON
      3. humanize.ts      — regex validator; retry once with feedback on fail
      4. image.ts         — download hero image → public/og/{slug}.{ext}
      5. mdx.ts           — write src/content/case-studies/{slug}.mdx
      6. git.ts           — git add + commit
  → push → deploy.yml → Astro build → GitHub Pages
```

### Three entry points, one pipeline

| Entry point | File | Notes |
|---|---|---|
| Daily cron | `.github/workflows/detect.yml` | **PAUSED** 2026-06-09; `workflow_dispatch` still active |
| Operator portal | `src/pages/admin/index.astro` | Static Astro page; calls GitHub API directly from browser with PAT |
| Slash commands + Issue Forms | `.github/workflows/on-comment.yml`, `on-issue.yml` | `/funded generate\|redraft\|delete\|status\|cost-estimate\|inspect <slug>` |

---

## Critical invariants (never violate these)

1. **Three Zod schemas gate every boundary** — fail any one and nothing ships:
   - `scripts/lib/schemas.ts` `ClaudeOutputSchema` — 14 keys Claude must return
   - `scripts/lib/schemas.ts` `CampaignSchema` — Honeycomb scrape payload
   - `src/content/config.ts` — MDX frontmatter at Astro build time

2. **`INDUSTRIES` is a controlled vocabulary** defined in `src/content/config.ts` AND mirrored in `scripts/lib/schemas.ts`. Both must stay in sync. Adding is safe; renaming or removing breaks existing MDX files.

3. **`campaignSlug` is the idempotency key** — `mdx.ts` uses it to detect existing case studies. Never change a published case study's `campaignSlug` frontmatter field.

4. **Humanization rules live in one place**: `scripts/lib/humanization-rules.ts`. The validator (`humanize.ts`) and the runtime prompt (`prompts/case-study-prompt.md` via `{{HUMANIZATION_*}}` placeholders) both read from this file. Add a banned pattern there and it automatically propagates to both the validator and future generations.

5. **The scripts/ CLI must not import from src/** — keeps CLI surface independent of the Astro build runtime. The `INDUSTRIES` list is deliberately duplicated between `schemas.ts` and `src/content/config.ts` for this reason.

6. **Rate limit is 1/day** (default). Never bypass `consume()` in `ratelimit.ts`. Backfill can override up to 10/day via `capOverride`.

7. **All commits to case-study content go to `main`** — the pipeline commits directly and pushes. The deploy workflow triggers on push to main.

---

## Data contracts

### Claude output (14 required keys)

The runtime prompt (`prompts/case-study-prompt.md`) instructs Claude to return a JSON object with exactly these fields:

| Field | Notes |
|---|---|
| `h1Heading` | ≥ 20 chars |
| `heroSubhead` | ≥ 20 chars |
| `storyHeading` | ≥ 4 chars |
| `story` | 800–1200 word HTML body; stored as MDX body, not frontmatter |
| `heroImageAlt` | 8–200 chars |
| `metaTitle` | 40–70 chars |
| `metaDescription` | 120–180 chars |
| `ogTitle` | 30–80 chars |
| `ogDescription` | 60–160 chars |
| `ctaText` | ≥ 3 chars |
| `slug` | lowercase kebab-case |
| `niche` | 2–80 chars |
| `industry` | must be one of `INDUSTRIES` |
| `systemSchemaJson` | JSON-LD array [LocalBusiness/subtype, Article] |

### Frontmatter schema (src/content/config.ts)

Key fields beyond Claude output (all required unless noted):

- `businessName`, `city`, `state` (2-letter uppercase) — from scrape
- `heroImage` — path under `/og/` (e.g. `/og/my-slug.jpg`)
- `ogImage` — optional, defaults to `heroImage`
- `quote`, `quoteAttribution` — optional founder quote
- `amountRaised` (int), `amountRaisedFormatted`, `investorCount` (int), `timeToFund` — funding metrics; **no goal/progress fields** (removed 2026-06-09)
- `campaignUrl`, `campaignId`, `campaignSlug` — source traceability
- `publishedDate` — coerced date

**Removed fields (do not re-add without migrating all 28+ MDX files):**
`goalAmount`, `goalAmountFormatted`, `percentOfGoal`, `percentOfGoalFormatted` — dropped in the metrics redesign; the raise-vs-goal narrative now lives in the story body only.

### MetricsStrip (src/components/MetricsStrip.astro)

Three tiles only: **Raised** / **Investors** / **Time to fund**. No progress-to-goal tile.

---

## Key files to know

| File | Purpose |
|---|---|
| `scripts/lib/pipeline.ts` | The 6-stage shared pipeline; start here for generation logic |
| `scripts/lib/claude.ts` | Anthropic API wrapper; default model `claude-opus-4-7`; override via `CASE_STUDY_MODEL` |
| `scripts/lib/humanize.ts` | AI-tells validator; two-strike policy (retry once on fail, then publish with warning) |
| `scripts/lib/humanization-rules.ts` | Single source of truth for banned words/phrases/patterns |
| `scripts/lib/schemas.ts` | Zod schemas for Claude output and campaign scrape payload |
| `scripts/lib/scrape.ts` | Extracts campaign data from invest.honeycombcredit.com `__NEXT_DATA__` |
| `scripts/lib/ratelimit.ts` | Rate limit ledger; state in `.state/ratelimit.json` (not committed — known gap) |
| `scripts/lib/mdx.ts` | MDX read/write; idempotency by `campaignSlug` |
| `src/content/config.ts` | Astro content collection + frontmatter Zod schema |
| `prompts/case-study-prompt.md` | Runtime system prompt (~1000 lines); `{{HUMANIZATION_*}}` placeholders filled at load time |
| `.state/detection-log.md` | Append-only cron audit log |
| `.github/workflows/detect.yml` | Daily cron (**PAUSED**); two schedule slots (04:47 + 11:23 UTC) are commented out |

---

## Environment variables

| Var | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes (for generation) | Repo secret in CI |
| `GITHUB_TOKEN` | Yes (for issue/commit ops) | Auto-injected in CI; need a PAT locally |
| `POSTHOG_API_KEY` | Yes (for cron detect) | Personal API key, `project:query:read` scope |
| `POSTHOG_PROJECT_ID` | Yes (for cron detect) | `39093` (Honeycomb Credit Production) |
| `CASE_STUDY_MODEL` | No | Override default `claude-opus-4-7` |
| `FUNDED_BOT_IDENTITY` | No | Set to `'1'` in CI to use bot identity for commits |

---

## Development commands

```bash
nvm use                       # Node 20+
npm install
npm run dev                   # Astro dev server at http://localhost:4321
npm run build                 # Static build → dist/
npm run typecheck             # astro sync && tsc --noEmit
npm test                      # vitest run (65 tests across 5 test files)

# Agent CLIs (needs ANTHROPIC_API_KEY + GITHUB_TOKEN in env)
npx tsx scripts/inspect.ts <slug>                        # diagnostic, $0
npx tsx scripts/generate.ts <slug>                       # ~$0.45
npx tsx scripts/redraft.ts <slug> --feedback="..."       # ~$0.45
npx tsx scripts/delete.ts <slug>                         # $0
npx tsx scripts/backfill.ts --slugs="A\nB\nC" [--force] [--dry-run] [--rate=N]
npx tsx scripts/detect.ts [--dry-run]                    # cron entry point
```

---

## Cost model

| Action | Cost |
|---|---|
| Generate or redraft | ~$0.45 (Opus 4.7; ~17K input + ~2.7K output tokens) |
| Inspect / delete / status / cost-estimate | $0 |
| Build + deploy | $0 (GitHub Actions free tier) |
| Steady state (~10 campaigns/month) | ~$5/month |

Pricing reference (keep in sync in `claude.ts`): Opus 4.7 = $15/Mtok input, $75/Mtok output.

---

## Operational state as of 2026-06-18

- **Cron: PAUSED** (2026-06-09). Uncomment `schedule:` block in `detect.yml` to resume.
- **Published**: 28 case studies in `src/content/case-studies/`
- **Last cron run**: 2026-05-31 (see `.state/detection-log.md`)
- **Rate-limit persistence gap**: `.state/ratelimit.json` is not committed; each workflow invocation starts fresh. See "Known gaps" in README.

---

## Known gaps (from README)

- **Founder input data**: No founder name/photo/Q&A in scrape payload. "Ask The Founders" tab on campaign pages would unlock this.
- **Rate-limit persistence**: `.state/ratelimit.json` not committed → fresh budget per invocation.
- **Pre-2026 campaigns**: Detection query floors at `2026-01-01`. ~570 older campaigns skipped by cron; use Backfill Issue Form for hand-picks.
