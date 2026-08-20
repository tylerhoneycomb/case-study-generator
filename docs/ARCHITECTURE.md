# Architecture

How the Collateral Development Agent works, end to end. This document is the
system contract: it describes the components, the data that flows between
them, and the invariants each boundary enforces. It is written to be
sufficient to rebuild the system from scratch.

For day-to-day operation (running a generation, pausing the cron,
troubleshooting a failure), see [OPERATIONS.md](./OPERATIONS.md).

---

## 1. What the system is

A static site at [funded.honeycombcredit.com](https://funded.honeycombcredit.com)
that publishes a marketing case study for every funded Honeycomb Credit
campaign.

The distinguishing design choice: **the repository is the agent.** There is
no server, no database, and no hosted runtime. Every capability is either a
GitHub Actions workflow, a TypeScript CLI in `scripts/`, or a file committed
to the repo.

| Concern | Where it lives |
|---|---|
| Compute | GitHub Actions runners (ephemeral) |
| Persistent state | Files committed to `main` (`src/content/`, `public/og/`, `.state/`) |
| Audit log | GitHub Issues, one per operation |
| Operator UI | A static page (`/admin`) that calls the GitHub API from the browser |
| Hosting | GitHub Pages, custom domain via `public/CNAME` |

Consequences worth internalizing before changing anything:

- **A run cannot remember anything it does not commit.** Runner disks are
  discarded. This is the root cause of the rate-limit gap in §8.
- **Every state change is a commit, so every state change is reviewable and
  revertible.** Deleting a case study is a `git revert` away from undone.
- **There is no auth system to build.** Authorization is GitHub repository
  collaborator status, checked by the workflows.

---

## 2. Component map

```
                    ┌───────────────────────────────────────────┐
   DISCOVERY        │  PostHog (Fivetran-mirrored               │
                    │  postgres.campaigns), queried via HogQL    │
                    └────────────────────┬──────────────────────┘
                                         │ funded slugs
                                         ▼
   TRIGGERS   ┌──────────┬───────────────┬──────────────┬─────────────┐
              │ detect   │ /funded slash │ Issue Forms  │ /admin      │
              │ (cron —  │ commands      │ (Backfill,   │ portal      │
              │ PAUSED)  │ on-comment.yml│  Redraft)    │ (browser →  │
              │          │               │ on-issue.yml │  GitHub API)│
              └────┬─────┴───────┬───────┴──────┬───────┴──────┬──────┘
                   │             │              │              │
                   └─────────────┴──────┬───────┴──────────────┘
                                        ▼
                    ┌───────────────────────────────────────────┐
   PIPELINE         │  scripts/lib/pipeline.ts — runPipeline()  │
                    │  scrape → Claude → humanize → image →     │
                    │  MDX → git commit                         │
                    └────────────────────┬──────────────────────┘
                                         │ commit to main
                                         ▼
                    ┌───────────────────────────────────────────┐
   PUBLISH          │  deploy.yml — typecheck, test, Astro      │
                    │  build, GitHub Pages deploy               │
                    └───────────────────────────────────────────┘
```

Every trigger converges on the same `runPipeline()` and the same audit
surface (a GitHub Issue). They differ only in where their arguments come
from and which preconditions they enforce.

---

## 3. Discovery — how a funded campaign is found

Discovery is a single HogQL query against PostHog, which mirrors Honeycomb's
production `postgres.campaigns` table via Fivetran. Implementation:
`scripts/lib/posthog.ts`.

```sql
SELECT slug, campaignname, campaignstage, campaignexpirationdate AS fundedat
FROM postgres.campaigns
WHERE campaignstage = 'Funded'
  AND campaignexpirationdate >= '2026-01-01'
ORDER BY campaignexpirationdate DESC
```

Design notes, each of which is load-bearing:

- **`campaignexpirationdate` is the fund-date proxy.** The mirrored table has
  no clean "funded at" timestamp. The scheduled close date is the closest
  available stand-in.
- **The 2026-01-01 floor is deliberate, not a bug.** Roughly 570 historical
  funded campaigns sit below it. They are visible to the query and
  intentionally excluded from automation; the operator hand-picks any worth
  publishing via the Backfill Issue Form.
- **PostHog replaced a listing scrape.** The original implementation scraped
  the `invest.honeycombcredit.com` Fundraising listing, which shows only the
  ~10 most-active campaigns. Any campaign that funded while outside that
  window was invisible to the cron permanently. PostHog returns every funded
  campaign in one query, closing that blind spot.
- **Discovery and content are separate sources.** PostHog answers *which
  campaigns funded*. The campaign page is still scraped for *what to write
  about* (§5).

`scripts/lib/posthog.ts` also exposes a name→slug resolver used by
`scripts/resolve.ts`, so an operator holding a business name rather than a
slug can find it for free (one PostHog query, no Anthropic spend, no Actions
run). Name literals are escaped before interpolation into HogQL.

---

## 4. Triggers

All four triggers are equivalent in outcome and audit trail.

| Trigger | Mechanism | Entry point |
|---|---|---|
| Detection cron | `detect.yml` schedule (**currently paused** — §9) | `scripts/detect.ts` |
| Slash command | `on-comment.yml` on any issue/PR comment | `scripts/dispatch-comment.ts` |
| Issue Form | `on-issue.yml` on issue open, routed by title prefix | `scripts/dispatch-issue.ts` |
| Operator portal | Browser JS opens an Issue and posts a slash command as its first comment | (falls through to `on-comment.yml`) |

**Slash commands** (`/funded <command>`), for repo collaborators:

```
/funded generate <campaign-slug>
/funded redraft <case-study-slug> [feedback…]
/funded delete <case-study-slug>
/funded status
/funded cost-estimate <slug…>
/funded inspect <campaign-slug>
```

**Issue Forms** route by title prefix: `[Backfill] …` → `scripts/backfill.ts`,
`[Redraft] …` → `scripts/redraft.ts`. Routing is by title rather than by
label because GitHub silently drops an Issue Form's `labels:` entries when
the named label does not already exist in the repo.

**Authorization** is enforced in `on-comment.yml`, which gates dispatch on
`author_association ∈ {OWNER, COLLABORATOR, MEMBER}`. Because the portal
posts comments under the operator's own PAT identity, a leaked token from a
non-collaborator dispatches nothing. Removing someone from the repo's
collaborator list revokes their access immediately — there is no separate
session or key to rotate.

---

## 5. The generation pipeline

`runPipeline()` in `scripts/lib/pipeline.ts`. Six stages, each posting
progress to the tracking issue when one is set.

**1 — Scrape.** `scripts/lib/scrape.ts` fetches
`invest.honeycombcredit.com/campaigns/{slug}` and extracts the campaign
payload from Next.js's `__NEXT_DATA__` blob, with HTML fallbacks for the
hero image. The result is validated against `CampaignSchema`. Defensive
parsing with explicit field-presence checks is what catches an upstream
`__NEXT_DATA__` shape change.

**2 — Generate.** `scripts/lib/claude.ts` sends the runtime prompt
(`prompts/case-study-prompt.md`) plus the scraped payload to the Anthropic
API. Default model `claude-opus-4-7`, overridable via `CASE_STUDY_MODEL`.
The response must parse as JSON and validate against `ClaudeOutputSchema`
(14 keys).

**3 — Humanize.** `scripts/lib/humanize.ts` runs a regex validator over the
generated copy, looking for the patterns that read as machine-written —
banned vocabulary, hedge phrases, "not just X but Y" pivots, em-dash
density, tricolon density. See §6 for the retry policy, which is the part
most often misread.

**4 — Image.** `scripts/lib/image.ts` fetches the campaign's OG image and
writes it to `public/og/{slug}.{ext}`, choosing the extension from the URL
and falling back to `Content-Type`.

**5 — Write MDX.** `scripts/lib/mdx.ts` writes
`src/content/case-studies/{slug}.mdx` — YAML frontmatter plus the rich-text
HTML story as the body. Generation always overwrites; the "skip if exists
unless `--force`" decision belongs to the caller.

**6 — Commit.** `scripts/lib/git.ts` stages and commits the MDX and the
image. The workflow pushes to `main`, which triggers the deploy.

### Field mapping

Claude returns 14 keys. They land as follows:

| Claude output key | Destination |
|---|---|
| `story` | The MDX body (HTML pastes directly into MDX) |
| `slug` | The MDX **filename**, and therefore the URL — not a frontmatter field |
| everything else | A frontmatter field of the same name |

Frontmatter also carries values the pipeline derives rather than generates:
scrape-sourced metrics (`amountRaised`, `investorCount`, `timeToFund`),
their pre-formatted display twins, image paths, and source-traceability
fields (`campaignUrl`, `campaignId`, `campaignSlug`).

---

## 6. Humanization — the retry policy

This is the single most misdocumented behavior in the system, so it is
stated precisely here.

- The validator runs after **every** Claude response.
- On the **first** failure, the pipeline re-calls Claude once, splicing the
  validator's flagged issues into the redraft feedback so the model can
  correct the specific patterns.
- If the **retry also fails, the pipeline publishes anyway** and the calling
  script applies a `humanization-warning` label to the tracking issue.

`MAX_HUMANIZATION_ATTEMPTS = 2`. The rationale is empirical: a hard gate
left real funded campaigns with no published case study at all (issues #39,
#41). Two-strikes-and-publish gives the model a correction round while
bounding cost at ~2× on the failure path, and surfaces the imperfect draft
for human review via the label instead of dropping it silently.

**The runtime prompt deliberately disagrees.** `prompts/case-study-prompt.md`
§13.5 still describes the validator as a hard gate. That framing is
intentional motivation aimed at the model on each attempt — the model should
not be told there is a safety net beneath it. Do not "fix" the prompt to
match the code.

`scripts/lib/humanization-rules.ts` is the single source of truth for the
banned patterns. Both consumers read from it: the validator compiles its
regex set from the lists, and `claude.ts` injects the human-readable forms
into the runtime prompt. Adding a banned phrase in one place updates both.

---

## 7. Validation boundaries

Three layered Zod schemas, each gating a different boundary and failing in a
different way.

| Schema | Validates | Failure mode |
|---|---|---|
| `src/content/config.ts` | MDX frontmatter, at build time | Astro build fails; the deploy does not ship |
| `scripts/lib/schemas.ts` → `ClaudeOutputSchema` | Claude's 14-key JSON response | Generation fails; tracking issue gets `error` |
| `scripts/lib/schemas.ts` → `CampaignSchema` | The scraped Honeycomb payload | Scrape fails; tracking issue gets `error` |

The ordering matters: a malformed generated file cannot reach production,
because the content schema runs inside the build that produces the deploy
artifact.

`INDUSTRIES` in `src/content/config.ts` is a controlled vocabulary of twelve
values that drives the Related Case Studies block. It is mirrored in the
runtime prompt §8 and is **additive only** — renaming a value orphans every
case study already using it.

### Issue labels

The tracking issue's labels are the machine-readable outcome of a run.

| Label | Meaning |
|---|---|
| `published` | Case study generated and committed |
| `humanization-warning` | Published, but the copy failed the validator twice — review it |
| `queued` | Deferred by the rate limit; a later run should pick it up |
| `error` | The pipeline failed; the message is in the issue comments |
| `deleted` | Case study removed |

---

## 8. State

Everything persistent is a committed file.

| Path | Contents | Committed? |
|---|---|---|
| `src/content/case-studies/*.mdx` | The case studies themselves | Yes |
| `public/og/*` | Hero / OG images, one per case study | Yes |
| `.state/detection-log.md` | One row per cron run, including zero-activity runs | Yes |
| `.state/ratelimit.json` | Today's generation counter | **No — see below** |

**Idempotency** comes from the content directory, not from a ledger.
`listAllCampaignSlugs()` reads the committed MDX files and filters
already-published campaigns out of the candidate list before any rate limit
is consumed. This is why running detection twice in a day costs nothing.

**The rate-limit ledger has a known gap.** `consume()` in
`scripts/lib/ratelimit.ts` writes `.state/ratelimit.json`, but no workflow
commits it back to the repo. Runner disks are ephemeral, so each workflow
invocation starts from a fresh 0-of-1 budget. In practice this has not
caused overspend — detection ran once a day, backfill caps itself within a
single process, and manual operations are infrequent — but the documented
"1/day across all triggers" semantic is more permissive than intended. The
fix is small (add the file to the per-slug commits in `pipeline.ts`); the
part needing thought is what happens when two workflows overlap.

**The detection log is the cron heartbeat.** It is appended on every run,
including dry runs and days with no activity, precisely so a quiet day is
distinguishable from a cron that did not fire — without generating issue
notifications for watchers.

---

## 9. Scheduling status

**The detection cron is paused.** Both schedule slots in `.github/workflows/detect.yml`
are commented out (paused 2026-06-09 to stop steady-state Anthropic spend
while the project is on hold). `workflow_dispatch` remains active, so
detection can still be run one-off from the Actions tab without editing the
file. `on-comment.yml` and `on-issue.yml` are untouched — they only fire on
explicit operator action.

The paused schedule was two daily slots:

```yaml
- cron: '47 4 * * *'   # 00:47 EDT — overnight, low GitHub contention
- cron: '23 11 * * *'  # 07:23 EDT — mid-morning backup, off the :00/:30 spikes
```

Two slots rather than one because GitHub Actions silently drops or delays
scheduled workflows under load, and which slot gets hit is not predictable.
Detection is idempotent (§8), so a second run on a good day costs nothing
and rescues a bad one.

Resume instructions are in [OPERATIONS.md](./OPERATIONS.md#pausing-and-resuming-the-cron).

---

## 10. Publishing

`deploy.yml` runs on every push to `main` and on manual dispatch:
typecheck (`astro sync && tsc --noEmit`) → test (`vitest run`) → `astro build`
→ upload artifact → deploy to GitHub Pages. Concurrency group `pages` with
`cancel-in-progress: false`, so a deploy in flight is never clobbered.

The site is Astro 5 with MDX content collections, TypeScript in strict mode
(including `noUncheckedIndexedAccess`), and Tailwind. `astro.config.mjs`
sets the production origin, `trailingSlash: 'never'`, and a sitemap filter
that excludes `/admin` (the page also carries `noindex`).

One workflow interaction is worth knowing: **a push authenticated with the
default `GITHUB_TOKEN` does not trigger downstream `push:` workflows.** That
is GitHub's recursion safeguard. `detect.yml` therefore dispatches
`deploy.yml` explicitly after a successful push, which is why it needs
`actions: write` permission.

---

## 11. Cost model

| Item | Cost |
|---|---|
| Generate or redraft | ~$0.45 per call (`claude-opus-4-7`, ~17K input + ~2.8K output tokens) |
| Inspect / delete / status / resolve | $0 |
| Astro build + Pages deploy | $0 (Actions free tier) |
| Steady state at ~10 funded campaigns/month | ~$5/month |

Pricing per model lives in `PRICING` in `scripts/lib/claude.ts` and must be
updated alongside `DEFAULT_MODEL`.

Rate limit: **1/day** by default across all triggers; the Backfill Issue
Form may override up to **10/day**. Work beyond the cap is deferred, marked
`queued`, and picked up by a later run. (Read §8 on the persistence gap
before relying on this as a hard spend ceiling.)

---

## 12. External dependencies

| Dependency | Used for | Failure signature |
|---|---|---|
| PostHog (HogQL API) | Funded-campaign discovery, name→slug resolution | `PostHogError`; detection aborts before spend |
| invest.honeycombcredit.com | Per-campaign content and hero image | `CampaignSchema` validation failure → `error` label |
| Anthropic API | Case-study generation | Generation fails → `error` label |
| GitHub API / Actions | Compute, audit log, auth, hosting | Workflow-level failure, visible in the Actions tab |

Required environment variables are listed in `.env.example`; the CI
equivalents are repository Actions secrets of the same names.
