# funded.honeycombcredit.com

The Collateral Development Agent. A static site at
[funded.honeycombcredit.com](https://funded.honeycombcredit.com) that
publishes a case study for every funded Honeycomb Credit campaign. The
**repo itself is the agent** — GitHub Actions provides the compute,
operators drive actions through GitHub Issues and a web portal, and the
case studies live as MDX files in this repo.

> **Detection cron is paused** (since 2026-06-09) to stop steady-state
> Anthropic spend while the project is on hold. Every manual trigger — the
> portal, slash commands, Issue Forms, and one-off `workflow_dispatch` runs
> — still works. See [docs/OPERATIONS.md](docs/OPERATIONS.md#pausing-and-resuming-the-cron)
> to resume it.

| Surface | URL |
|---|---|
| **Live site** | https://funded.honeycombcredit.com |
| **Operator portal** (you'll be here most of the time) | https://funded.honeycombcredit.com/admin |
| **Audit log** (every action, every run) | https://github.com/tylerhoneycomb/case-study-generator/issues |
| **Cron heartbeat** (no-email file log) | [`.state/detection-log.md`](.state/detection-log.md) |

## Documentation

| Document | What's in it |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the system works, end to end — components, data flow, schemas, invariants. Written to be sufficient to rebuild from scratch. |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Runbook — getting access, publishing, pausing/resuming the cron, costs, troubleshooting. |
| [prompts/case-study-prompt.md](prompts/case-study-prompt.md) | The runtime prompt sent to Claude on every generation. Voice, narrative beats, output contract. |

The `/admin` portal carries a short quickstart for operators who never open
the repo. Anything longer than that lives here, in version control.

## How it works

```
       ┌────────────────────────┐
       │   detection (paused)   │  detect.yml — queries PostHog (Fivetran-mirrored
       │   detect.yml           │  postgres.campaigns) for funded slugs ≥ 2026-01-01,
       └────────────┬───────────┘  filters out already-published, newest first.
                    │
                    ▼
       ┌────────────────────────┐  scripts/lib/pipeline.ts
       │   per-slug pipeline    │  scrape → Claude (prompts/case-study-prompt.md)
       │                        │  → humanization validator → image fetch
       └────────────┬───────────┘  → MDX commit → push.
                    │
                    ▼
       ┌────────────────────────┐  deploy.yml — Astro build, GitHub Pages deploy.
       │   site rebuild         │  Live within ~2 min of any commit to main.
       └────────────────────────┘
```

The same pipeline is reachable manually, and all routes converge on the same
audit log and the same `scripts/` CLI:

- **Operator portal** — https://funded.honeycombcredit.com/admin (generate/redraft/delete/inspect; PAT auth in the browser, no backend)
- **Slash commands** — `/funded generate|redraft|delete|status|cost-estimate|inspect <slug>` in any issue/PR comment by a repo collaborator
- **Issue Forms** — Issues → New → "Backfill case studies" or "Redraft with feedback" for high-input operations

## Stack

- **Astro 5** + TypeScript (strict, `noUncheckedIndexedAccess`) + Tailwind + MDX content collections
- **GitHub Pages** from a private repo (GitHub Pro)
- **GitHub Actions** for detection, the on-comment and on-issue dispatchers, and deploy
- **Anthropic SDK** with Claude Opus 4.7 for generation (~$0.45 per case study)
- **Vitest** for unit tests; `astro sync && tsc --noEmit` + a 77-test suite gate every deploy

## Local development

```bash
nvm use            # Node 20+
npm install
npm run dev        # http://localhost:4321
npm run build      # static output to dist/
npm run typecheck  # astro sync && tsc --noEmit
npm test           # vitest run (77 tests)
```

Running the agent CLIs locally needs the environment in
[`.env.example`](.env.example) — `ANTHROPIC_API_KEY` for generation,
`POSTHOG_API_KEY` + `POSTHOG_PROJECT_ID` for discovery and name resolution,
`GITHUB_TOKEN` for issue comments. In CI the same names are supplied as
repository Actions secrets.

```bash
npx tsx scripts/resolve.ts "Biz Name" ...    # name → slug, FREE (PostHog, no Claude, no Action)
npx tsx scripts/inspect.ts <slug>            # diagnostic, no spend
npx tsx scripts/generate.ts <slug>           # ~$0.45 spend
npx tsx scripts/redraft.ts <slug> --feedback="..."
npx tsx scripts/delete.ts <slug>
npx tsx scripts/backfill.ts --slugs="A\nB\nC" [--force] [--dry-run] [--rate=N]
npx tsx scripts/detect.ts [--dry-run]        # the cron entry point
```

**Finding a campaign by name (cheaply).** When you have a business *name* but
not its Honeycomb slug, run `scripts/resolve.ts` first — it answers "does
this exist / is it funded / what's the slug?" with one free PostHog query and
exits non-zero unless every name resolves to exactly one fundable campaign,
so it doubles as a gate before any paid generation. Details in
[docs/OPERATIONS.md](docs/OPERATIONS.md#when-you-have-a-name-but-not-a-slug).

## Repo layout

```
src/
  content/case-studies/   ← one .mdx per funded campaign (agent writes here)
  content/config.ts       ← Zod schema; single source of truth for frontmatter
  pages/                  ← Astro file-based routing
    [...slug].astro       ← case-study renderer
    index.astro           ← directory page
    admin/index.astro     ← operator portal (noindex)
    rss.xml.js            ← /rss.xml
  layouts/CaseStudy.astro ← case-study layout (hero + metrics + body + CTA)
  components/             ← Hero, MetricsStrip, Quote, Cta, FloatingCta,
                            JsonLd, BaseHead, SiteHeader, SiteFooter
public/
  og/                     ← hero / OG images, one per case study
  demo/                   ← static preview pages (floating-CTA demo)
  CNAME                   ← funded.honeycombcredit.com
scripts/
  generate.ts redraft.ts delete.ts backfill.ts detect.ts inspect.ts
  resolve.ts status.ts cost-estimate.ts dispatch-comment.ts dispatch-issue.ts
  lib/
    posthog.ts            ← HogQL client — funded-slug discovery + name→slug resolver
    scrape.ts             ← __NEXT_DATA__ + HTML extraction (with hero-image fallbacks)
    claude.ts             ← Anthropic SDK wrapper, output validation, cost estimation
    humanize.ts           ← AI-tells validator (port of velo_humanization.jsw)
    humanization-rules.ts ← banned phrases/openers — feeds BOTH validator and prompt
    ratelimit.ts          ← 1/day default, 10/day backfill cap, UTC reset
    pipeline.ts           ← shared per-slug pipeline used by generate/redraft/backfill
    github.ts             ← Octokit wrappers (createIssue, addComment, etc.)
    mdx.ts                ← MDX read/write, idempotency by campaignSlug
    parse-slugs.ts        ← Backfill input parser (defends against code-fence drift)
    image.ts format.ts schemas.ts log.ts git.ts args.ts
.github/
  workflows/
    deploy.yml            ← Astro build + Pages deploy on push to main
    detect.yml            ← detection cron (schedule currently commented out)
    on-comment.yml        ← /funded slash dispatcher
    on-issue.yml          ← Issue Form dispatcher (routes by title prefix)
  ISSUE_TEMPLATE/
    backfill.yml redraft-with-feedback.yml config.yml
.state/
  detection-log.md        ← cron heartbeat (one row per run)
prompts/
  case-study-prompt.md    ← runtime prompt sent to Claude on every generation
docs/
  ARCHITECTURE.md OPERATIONS.md
```

### Operational state

| File | What it shows | Notes |
|---|---|---|
| [`.state/detection-log.md`](.state/detection-log.md) | One row per detection run — PostHog-returned / already-published / eligible / generated / rate-limit deferred / failed | Appended on every run including dry runs and quiet days. Last row 2026-06-01; the cron has been paused since. |

> ⚠ `.state/ratelimit.json` is written by `consume()` during a run but is
> **not committed**, so it does not exist in the repo and each workflow
> invocation starts from a fresh budget. See "Known gaps" below.

Three layered Zod schemas gate the three boundaries:

| File | Validates | Failure mode |
|---|---|---|
| `src/content/config.ts` | MDX frontmatter at build time | Astro build fails, deploy doesn't ship |
| `scripts/lib/schemas.ts` `ClaudeOutputSchema` | Claude's 14-key JSON response | Generation fails, tracking issue gets `error` label |
| `scripts/lib/schemas.ts` `CampaignSchema` | Honeycomb scrape payload | Scrape fails, tracking issue gets `error` label |

When Honeycomb's `__NEXT_DATA__` shape changes, the third schema is what
catches it — defensive parsing with explicit field-presence checks.

## Cost and rate model

| Item | Cost |
|---|---|
| Generate or redraft | ~$0.45 per call (Opus 4.7, ~17K input + ~2.8K output tokens) |
| Inspect / delete / status / resolve | $0 |
| Astro build + Pages deploy | $0 (GitHub Actions free tier) |
| Steady state at ~10 funded campaigns/month | ~$5/month |

Rate limit: **1/day** across all triggers (detection + manual + portal). The
Backfill issue form can override up to **10/day**. Excess work is deferred
and surfaced via the `queued` label.

## Known gaps

- **Founder-level input data.** The current input payload (campaign summary +
  use-of-proceeds + metrics) doesn't include the founder's name, photo, or
  verbatim Q&A. The "Ask The Founders" tab on each campaign page would unlock
  this and is the single biggest quality lever still on the roadmap. See
  `prompts/case-study-prompt.md` §6 for what the prompt does to compensate today.
- **Rate-limit persistence is per-run, not per-day.** `consume()` in
  `scripts/lib/ratelimit.ts` writes `.state/ratelimit.json`, but the workflows
  don't commit it back, so each new workflow invocation starts with a fresh
  0-of-1 budget. This hasn't caused overspend in practice, but the documented
  "1/day across all triggers" semantic is more permissive than intended. The
  fix is small (add the file to per-slug commits in `pipeline.ts`); the race
  conditions between overlapping workflows are the part worth thinking through.
- **Pre-2026 historical campaigns are not auto-published.** The PostHog
  detection query floors at `campaignexpirationdate >= '2026-01-01'`. ~570
  historical funded campaigns are visible to PostHog but intentionally skipped
  — hand-pick any worth publishing via the Backfill Issue Form.
- **The runtime prompt describes the humanization validator as a hard gate;
  the pipeline actually retries once and then publishes with a
  `humanization-warning` label.** This divergence is deliberate — see
  [docs/ARCHITECTURE.md §6](docs/ARCHITECTURE.md#6-humanization--the-retry-policy)
  before "fixing" either side.
