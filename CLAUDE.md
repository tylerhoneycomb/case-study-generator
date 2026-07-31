# CLAUDE.md

Orientation for an AI agent (or another AI coding tool) picking up work in
this repo. For the full human-facing picture — architecture diagram, cost
model, repo layout — read [`README.md`](README.md) first; this file only
adds what an agent needs that the README doesn't spell out.

## What this repo is

A static site generator for [funded.honeycombcredit.com](https://funded.honeycombcredit.com).
**The repo is the agent**: GitHub Actions workflows (not a separate service)
run the detection cron, dispatch slash commands, and deploy the site. There
is no backend server anywhere in this stack — the operator portal at `/admin`
is a static page that calls the GitHub API directly from the browser.

Every commit that publishes or edits a case study is made by an AI agent
(Claude, via `scripts/generate.ts` / `redraft.ts` / `backfill.ts`, dispatched
by a GitHub Issue comment or the daily cron). If you are an agent reading
this to make a change, you are working in the same repo — and quite possibly
the same style of workflow — that the production pipeline itself runs on.
Match its conventions rather than importing conventions from elsewhere.

## Before you start

- Read `README.md` in full — it's kept current and is the source of truth
  for architecture, cost model, and repo layout.
- Check whether the daily cron (`detect.yml`) is currently paused or armed —
  README's "How it works" section states the current status. Don't assume
  it's running; don't "fix" a paused schedule without being asked.
- The generation prompt lives at `prompts/case-study-prompt.md`. It is long
  and detailed by design (voice rules, humanization constraints, worked
  examples). If a task touches case-study output quality, read the relevant
  section there before changing `scripts/lib/claude.ts` or the schema.

## Required checks before calling anything done

```bash
npm run typecheck   # astro sync && tsc --noEmit — must be clean
npm test             # vitest run — all tests must pass (currently 77)
```

Both gate every deploy (`deploy.yml`). A change that fails either one never
reaches the live site even if it's merged to `main`.

## The three schema boundaries

Content flows through three independently-enforced Zod schemas
(`scripts/lib/schemas.ts` and `src/content/config.ts`). If you add or rename
a field anywhere in the pipeline, all three need to move together:

1. `CampaignSchema` — validates the Honeycomb scrape payload (`scrape.ts`).
2. `ClaudeOutputSchema` — validates Claude's JSON response (`claude.ts`).
3. `src/content/config.ts` — validates MDX frontmatter at Astro build time.

A field dropped from one but not the others fails silently in one of two
ways: build breaks (schema too strict) or the field is written but never
rendered (schema too loose, no component reads it). Grep all three before
trusting a schema change is complete — see the `feat(metrics): drop
progress-to-goal` commit for the pattern of what a clean three-way removal
looks like (schema + component + one-shot content migration, all in one
commit).

## Conventions observed in this repo's own commit history

- Prefixes: `feat(case-study): publish <Name> (<slug>)` for every new case
  study, `feat(resolve):` / `fix(resolve):` / `harden(resolve):` for the
  name→slug resolver, `chore(state): append detection log` for automated
  heartbeat commits, `chore(detect): ...` for cron-schedule operational
  changes. Keep new commits inside this taxonomy rather than inventing a
  parallel one.
- Security-relevant fixes on `scripts/lib/posthog.ts` (SQL-literal escaping,
  punctuation-only input handling) came from adversarial review of
  operator-supplied free text reaching a HogQL query. Any new code path that
  interpolates user/operator input into a query deserves the same scrutiny.
- `.state/detection-log.md` and `.state/ratelimit.json` are runtime state,
  not source — `detection-log.md` is intentionally committed (it's the
  audit trail); `ratelimit.json` is written but *not* committed (see "Known
  gaps" in README.md — this is a known, accepted gap, not a bug to silently
  fix).

## Where things live (quick index — see README.md for the full tree)

- `scripts/lib/pipeline.ts` — the shared per-slug pipeline (scrape → Claude
  → humanization validator → image fetch → MDX write → commit). Every
  script that produces a case study (`generate.ts`, `redraft.ts`,
  `backfill.ts`) calls into this rather than duplicating pipeline logic.
- `scripts/lib/humanize.ts` — regex-based AI-tells validator (a ported
  business rule, not a style preference — see the file for the rule
  provenance).
- `scripts/resolve.ts` — free (no Claude, no Actions run) name→slug lookup
  via PostHog. Use this instead of a paid `generate` call when you only know
  a business name, not its Honeycomb slug.
- `src/pages/admin/index.astro` — the operator portal; its embedded
  `⚠ Read me first` block is the canonical *operator*-facing README (as
  opposed to this file, which is the canonical *agent*-facing one). Keep it
  in sync with actual workflow behavior — it has drifted before (e.g. it
  described the cron's discovery mechanism after that mechanism moved from
  page-scraping to PostHog, and didn't reflect the cron pause) and is easy
  to forget because it doesn't live in `.md`.

## Known gaps

See the "Known gaps" section at the bottom of `README.md` — it's kept
current and shouldn't be duplicated here. Don't silently "fix" any of them
without checking in; each one is a documented, accepted tradeoff, not an
oversight.
