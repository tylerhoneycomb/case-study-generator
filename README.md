# funded.honeycombcredit.com

The Collateral Development Agent. A static site at
[funded.honeycombcredit.com](https://funded.honeycombcredit.com) that
publishes a case study for every funded Honeycomb Credit campaign. The
**repo itself is the agent** — GitHub Actions runs the detection cron,
operators drive ad-hoc actions through GitHub Issues and a web portal, and
the case studies live as MDX files in this repo.

| Surface | URL |
|---|---|
| **Live site** | https://funded.honeycombcredit.com |
| **Operator portal** (you'll be here most of the time) | https://funded.honeycombcredit.com/admin |
| **Audit log** (every action, every cron run) | https://github.com/tylerhoneycomb/case-study-generator/issues |
| **Daily cron heartbeat** (no-email file log) | [`.state/detection-log.md`](.state/detection-log.md) |

## How it works

```
       ┌────────────────────────┐
       │   dual daily cron      │  detect.yml — queries PostHog (Fivetran-mirrored
       │   (detect.yml)         │  postgres.campaigns) for funded slugs ≥ 2026-01-01,
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

The same pipeline is also reachable manually:

- **Operator portal** — https://funded.honeycombcredit.com/admin (forms for generate/redraft/delete/inspect; PAT auth in browser, no backend)
- **Slash commands** — `/funded generate|redraft|delete|status|cost-estimate|inspect <slug>` in any issue/PR comment by a repo collaborator
- **Issue Forms** — Issues → New → "Backfill case studies" or "Redraft with feedback" for high-input ops

All three converge on the same audit log (Issues tab) and use the same `scripts/` CLI under the hood.

## Operator documentation

The full operator README — quickstart, sharing access, costs, troubleshooting, "How it works" deep-dive — lives on the portal at `/admin`. It's collapsed under a `⚠ Read me first` block; click to expand. Send that URL to a coworker rather than this file.

## Stack

- **Astro 5** + TypeScript (strict, `noUncheckedIndexedAccess`) + Tailwind + MDX content collections
- **GitHub Pages** from a private repo (GitHub Pro)
- **GitHub Actions** for cron, on-comment dispatcher, on-issue dispatcher, deploy
- **Anthropic SDK** with Claude Opus 4.7 for generation (~$0.45 per case study)
- **Vitest** for unit tests; `astro sync && tsc --noEmit` + 65-test suite gate every deploy

## Local development

```bash
nvm use            # Node 20+
npm install
npm run dev        # http://localhost:4321
npm run build      # static output to dist/
npm run typecheck  # astro sync && tsc --noEmit
npm test           # vitest run (65 tests)
```

Running the agent CLIs locally needs `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` in env. In CI both are wired up via repo secrets and `secrets.GITHUB_TOKEN`.

```bash
npx tsx scripts/inspect.ts <slug>            # diagnostic, no spend
npx tsx scripts/generate.ts <slug>           # ~$0.45 spend
npx tsx scripts/redraft.ts <slug> --feedback="..."
npx tsx scripts/delete.ts <slug>
npx tsx scripts/backfill.ts --slugs="A\nB\nC" [--force] [--dry-run] [--rate=N]
npx tsx scripts/detect.ts [--dry-run]        # the cron entry point
```

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
  components/             ← Hero, MetricsStrip, Quote, Cta, JsonLd, BaseHead, …
public/
  og/                     ← hero / OG images, one per case study
  CNAME                   ← funded.honeycombcredit.com
scripts/
  generate.ts redraft.ts delete.ts backfill.ts detect.ts inspect.ts
  status.ts cost-estimate.ts dispatch-comment.ts dispatch-issue.ts
  lib/
    posthog.ts            ← HogQL client — discovery source for funded slugs
    scrape.ts             ← __NEXT_DATA__ + HTML extraction (with hero-image fallbacks)
    claude.ts             ← Anthropic SDK wrapper, output validation
    humanize.ts           ← AI-tells regex validator (port of velo_humanization.jsw)
    ratelimit.ts          ← 1/day default, 10/day backfill cap, UTC reset
    pipeline.ts           ← shared per-slug pipeline used by generate/redraft/backfill
    github.ts             ← Octokit wrappers (createIssue, addComment, etc.)
    mdx.ts                ← MDX read/write, idempotency by campaignSlug
    parse-slugs.ts        ← Backfill input parser (defends against code-fence drift)
    image.ts format.ts schemas.ts log.ts git.ts args.ts
.github/
  workflows/
    deploy.yml            ← Astro build + Pages deploy on push to main
    detect.yml            ← cron at 12:07 UTC daily
    on-comment.yml        ← /funded slash dispatcher
    on-issue.yml          ← Issue Form dispatcher (routes by title prefix)
  ISSUE_TEMPLATE/
    backfill.yml redraft-with-feedback.yml config.yml
.state/
  detection-log.md           ← daily cron heartbeat (one row per run)
  ratelimit.json             ← today's generation counter
prompts/
  case-study-prompt.md  ← runtime prompt sent to Claude on every generation
```

### Operational state (live status)

| File | What it shows | Created when |
|---|---|---|
| [`.state/detection-log.md`](.state/detection-log.md) | Daily cron heartbeat (one row per run; PostHog-returned / already-published / eligible / generated / rate-limit deferred / failed) | First detect.yml run after the file was introduced; appended on every subsequent run |

> ⚠ `.state/ratelimit.json` is written by `consume()` during a workflow run but **not currently committed**. See "Known gaps" below.

Three layered Zod schemas, each gating a different boundary:

| File | Validates | Failure mode |
|---|---|---|
| `src/content/config.ts` | MDX frontmatter at build time | Astro build fails, deploy doesn't ship |
| `scripts/lib/schemas.ts` `ClaudeOutputSchema` | Claude's 14-key JSON response | Generation fails, tracking issue gets `error` label |
| `scripts/lib/schemas.ts` `CampaignSchema` | Honeycomb scrape payload | Scrape fails, tracking issue gets `error` label |

When Honeycomb's `__NEXT_DATA__` shape changes, the third schema is what catches it — defensive parsing with explicit field-presence checks.

## Cost and rate model

| Item | Cost |
|---|---|
| Generate or redraft | ~$0.45 per call (Opus 4.7, ~17K input + ~2.7K output tokens) |
| Inspect / delete / status | $0 |
| Astro build + Pages deploy | $0 (GitHub Actions free tier) |
| Steady state at ~10 funded campaigns/month | ~$5/month |

Rate limit: **1/day** across all triggers (cron + manual + portal). Backfill issue form can override up to **10/day**. Excess work queues to subsequent days, surfaced via `queued` label on the relevant issues. The cron drains queued issues before scanning for new ones.

## Known gaps

- **Founder-level input data.** Current input payload (campaign summary + use-of-proceeds + metrics) doesn't include the founder's name, photo, or verbatim Q&A. The "Ask The Founders" tab on each campaign page would unlock this and is the single biggest quality lever still on the roadmap. See `prompts/case-study-prompt.md` §6 for what the prompt does to compensate today.
- **Rate-limit persistence is per-run, not per-day.** `consume()` in `scripts/lib/ratelimit.ts` writes `.state/ratelimit.json` but the workflows don't commit it back to the repo, so each new workflow invocation starts with a fresh 0-of-1 budget. In practice this hasn't caused over-spend (the cron runs once per day; backfill caps itself; manual ops are infrequent) but the documented "1/day across all triggers" semantic is more permissive than intended. Fix is small (add the file to per-slug commits in `pipeline.ts`); race conditions to think through if multiple workflows overlap.
- **Pre-2026 historical campaigns are not auto-published.** The PostHog detection query floors at `campaignexpirationdate >= '2026-01-01'`. ~570 historical funded campaigns are visible to PostHog but intentionally skipped by the cron — Tyler will hand-pick any he wants published via the Backfill Issue Form.
