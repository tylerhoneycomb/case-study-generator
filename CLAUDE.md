# CLAUDE.md — Agent context for case-study-generator

This file is the authoritative quick-reference for AI coding tools working in this repo. It supplements the README (which is operator-facing) with implementation-level context.

## What this project is

An automated case-study publishing system for Honeycomb Credit. When a small-business loan campaign is funded on invest.honeycombcredit.com, this system scrapes the campaign, calls Claude (Opus 4.7) to write a 800–1200-word case study, runs a humanization validator, stores a hero image, writes an MDX file, commits to main, and deploys to GitHub Pages at funded.honeycombcredit.com. **The repo itself is the agent** — there is no backend; GitHub Actions is the runtime.

## Build and test commands

```bash
npm install
npm run dev          # Astro dev server at http://localhost:4321
npm run typecheck    # astro sync && tsc --noEmit (strict + noUncheckedIndexedAccess)
npm test             # vitest run — 65 tests across 5 files
npm run build        # Astro static build to dist/
```

Scripts require `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` in env. In CI they come from repo secrets.

```bash
npx tsx scripts/inspect.ts <slug>         # diagnostic only, $0 cost
npx tsx scripts/generate.ts <slug>        # generates + commits, ~$0.45
npx tsx scripts/redraft.ts <slug> --feedback="..."
npx tsx scripts/delete.ts <slug>
npx tsx scripts/backfill.ts --slugs="A\nB\nC" [--force] [--dry-run] [--rate=N]
npx tsx scripts/detect.ts [--dry-run]     # the cron entry point
```

## Architecture: data flow

```
PostHog (HogQL query)
  → scripts/detect.ts          — discovers funded slugs >= 2026-01-01
    → scripts/lib/pipeline.ts  — shared per-slug pipeline (generate/redraft/backfill all converge here)
      → scrape.ts              — fetchCampaign() extracts __NEXT_DATA__ + hero image URL
      → claude.ts              — sends prompts/case-study-prompt.md + campaign JSON to Claude
      → humanize.ts            — regex validator; retry once on fail, then publish-with-warning
      → image.ts               — fetches hero image, writes to public/og/{slug}.{ext}
      → mdx.ts                 — writeCaseStudy() writes src/content/case-studies/{slug}.mdx
      → git.ts                 — git add + commit per slug
  → git push → deploy.yml → Astro build → GitHub Pages
```

**Cron status (2026-06-09):** The schedule block in `.github/workflows/detect.yml` is commented out. Manual `workflow_dispatch` still works. To resume, uncomment the two `- cron:` lines.

## Key files

| File | Role |
|---|---|
| `scripts/lib/pipeline.ts` | The shared 6-stage per-slug pipeline. All generation paths end here. |
| `scripts/lib/claude.ts` | Anthropic SDK wrapper. Model: `claude-opus-4-7` (env override: `CASE_STUDY_MODEL`). |
| `scripts/lib/humanization-rules.ts` | **Single source of truth** for banned phrases, hedge patterns, generic openers, and density thresholds. Both `humanize.ts` (validator) and `claude.ts` (prompt injection) read from here. Edit only this file to add/remove a rule. |
| `scripts/lib/humanize.ts` | Post-generation validator. Builds regex set from `humanization-rules.ts`. |
| `scripts/lib/schemas.ts` | Zod: `ClaudeOutputSchema` (14-key Claude output) + `CampaignSchema` (scrape payload). Failure = generation error. |
| `src/content/config.ts` | Zod: MDX frontmatter schema. Failure = Astro build fails, deploy blocked. |
| `scripts/lib/ratelimit.ts` | 1/day default cap; 10/day backfill override. Reads/writes `.state/ratelimit.json`. |
| `prompts/case-study-prompt.md` | 1,000-line system prompt. Contains `{{HUMANIZATION_*}}` placeholders injected from `humanization-rules.ts` at call time. |
| `.state/detection-log.md` | Cron heartbeat — one row per run. Committed after every cron/detect invocation. |

## Content collection schema (frontmatter + body)

Every `.mdx` under `src/content/case-studies/` must conform to the Zod schema in `src/content/config.ts`. Validation runs at `astro build` time — a bad file blocks the deploy.

**Claude supplies (14 fields):** `h1Heading`, `heroSubhead`, `storyHeading`, `story` (MDX body), `heroImageAlt`, `metaTitle`, `metaDescription`, `ogTitle`, `ogDescription`, `ctaText`, `slug` (becomes filename), `niche`, `industry`, `systemSchemaJson`

**Agent supplies (from scrape + pipeline):** `businessName`, `city`, `state`, `heroImage`, `ogImage`, `amountRaised`, `amountRaisedFormatted`, `investorCount`, `timeToFund`, `campaignUrl`, `campaignId`, `campaignSlug`, `publishedDate`

**Industry vocabulary** (`INDUSTRIES` in `src/content/config.ts` and mirrored in `scripts/lib/schemas.ts`): additive-only. Never rename or remove a value — it would orphan existing case studies that reference it.

## Pipeline stages (scripts/lib/pipeline.ts)

1. **Fetch** — `fetchCampaign(slug)` scrapes `__NEXT_DATA__` from invest.honeycombcredit.com. Fails fast if required fields (city, state, target, summary) are missing.
2. **Claude** — `generateCaseStudy(payload)` sends the system prompt + campaign JSON. Returns `ClaudeOutput` (14 keys).
3. **Humanize** — `validateCopy()` runs regex rules from `humanization-rules.ts`. On fail: one retry with feedback spliced into `redraftFeedback`. If retry also fails, publishes anyway and sets `humanizationWarnings` (caller applies `humanization-warning` label). Max attempts: `MAX_HUMANIZATION_ATTEMPTS = 2`.
4. **Image** — `extractHeroImageUrl()` walks a 6-level fallback chain in `scrape.ts`. `fetchAndStoreHeroImage()` writes to `public/og/{slug}.{ext}`.
5. **Write MDX** — `writeCaseStudy()` in `mdx.ts`. Idempotent by `campaignSlug` — re-running on an existing slug overwrites in place.
6. **Commit** — `git add` + `git commit` with message `feat(case-study): publish {name} ({slug})`. Push is handled by the calling workflow, not the pipeline.

## Humanization system

`scripts/lib/humanization-rules.ts` is the canonical list of:
- `BANNED_VOCABULARY` — AI clichés (`delve`, `tapestry`, `groundbreaking`, etc.)
- `BANNED_HEDGE_PHRASES` — filler transitions (`it's worth noting`, `at the end of the day`, etc.)
- `NOT_JUST_BUT_PIVOTS` — "not just/only/merely/simply X but Y" constructions
- `BANNED_OPENERS` — generic first-sentence starters
- `DENSITY_THRESHOLDS` — em-dash > 3 per 500 words; tricolon > 2 per 500 words

**To add a rule:** edit `humanization-rules.ts` only. Both the runtime validator and the Claude system prompt update automatically on the next generation.

The validator runs on the plain-text version of `story` (HTML stripped). The prompt receives the same rules via `{{HUMANIZATION_*}}` substitution placeholders.

## Rate limiting

`scripts/lib/ratelimit.ts` tracks a UTC-day counter in `.state/ratelimit.json`. Default cap: 1/day. Backfill override: up to 10/day.

**Known gap:** The workflows do not commit `.state/ratelimit.json`. Each new workflow invocation starts at 0. In practice this is acceptable (cron runs once per day; backfill is manual and self-capping) but the "1/day across all triggers" semantic is imprecise. To fix: add `.state/ratelimit.json` to the per-slug commit in `pipeline.ts`, handling concurrent-workflow races.

## Cron and GitHub Actions

| Workflow | Trigger | Purpose |
|---|---|---|
| `detect.yml` | Daily (paused) + `workflow_dispatch` | Scan PostHog, run pipeline per new slug |
| `deploy.yml` | Push to main + `workflow_dispatch` | Typecheck → test (65) → build → Pages deploy |
| `on-comment.yml` | `issue_comment` with `/funded ` prefix | Slash commands: generate, redraft, delete, status, cost-estimate, inspect |
| `on-issue.yml` | Issues opened/edited/labeled | Routes `[Backfill]` and `[Redraft]` issue forms to scripts |

**Recursion protection:** Pushes made with the default `GITHUB_TOKEN` do not trigger downstream `push:` workflows. The detect/comment/issue workflows explicitly dispatch `deploy.yml` via `gh workflow run deploy.yml --ref main` after a successful push.

**Auth boundary for slash commands:** `author_association` must be `OWNER`, `COLLABORATOR`, or `MEMBER`. Non-collaborators are silently ignored.

## GitHub Issues as audit log

Every generation, failure, and detection run opens or updates a GitHub Issue. Labels:
- `detection` — opened by the cron for each eligible campaign
- `published` — applied when the case study is live
- `error` — pipeline failure; stays open until resolved
- `humanization-warning` — published but the validator found issues; consider redraft
- `dispatched` — anti-replay guard on issue-form submissions
- `meta` — daily summary issues (generated + failed > 0 only)

## Adding a new case study manually

Use the operator portal at `https://funded.honeycombcredit.com/admin` or:

```bash
npx tsx scripts/inspect.ts <slug>   # verify the campaign scrapes correctly first
npx tsx scripts/generate.ts <slug>  # generates, commits, does NOT push
git push origin main                 # triggers deploy.yml
```

## Extending the system

**Add a new industry value:** append to `INDUSTRIES` in both `src/content/config.ts` and `scripts/lib/schemas.ts`. Never rename existing values.

**Change the Claude model:** set `CASE_STUDY_MODEL` env var or update `DEFAULT_MODEL` in `scripts/lib/claude.ts`. Update the `PRICING` map in the same file and the cost estimate in the README.

**Add a new frontmatter field:** add to `src/content/config.ts` schema, the `frontmatter` object in `scripts/lib/pipeline.ts`, and if Claude should supply it, to `ClaudeOutputSchema` in `scripts/lib/schemas.ts` and `prompts/case-study-prompt.md`.

**Modify the prompt:** edit `prompts/case-study-prompt.md`. Humanization rule lists are injected via `{{HUMANIZATION_*}}` placeholders — do not hardcode them in the prompt file.

## TypeScript configuration

Strict mode + `noUncheckedIndexedAccess` + `noImplicitOverride`. All index access returns `T | undefined`. The path alias `~/*` maps to `src/*`. Scripts do not import from `src/` — keep the CLI surface independent of the Astro runtime.
