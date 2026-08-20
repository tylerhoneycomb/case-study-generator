# Operations runbook

Day-to-day operation of the Collateral Development Agent: how to publish a
case study, control the cron, and diagnose a failure.

For how the system works internally, see [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Current status

| | |
|---|---|
| **Detection cron** | ⏸ **Paused** since 2026-06-09 (both schedule slots commented out in `detect.yml`) |
| **Manual triggers** | ✅ Active — portal, slash commands, Issue Forms, and `workflow_dispatch` all work |
| **Last cron run** | 2026-06-01 (last row in [`.state/detection-log.md`](../.state/detection-log.md)) |
| **Published case studies** | 32 |

The cron was paused to stop steady-state Anthropic spend while the project
is on hold. Nothing else was disabled — everything that fires on explicit
operator action still runs normally.

---

## Surfaces

| Surface | URL |
|---|---|
| Live site | https://funded.honeycombcredit.com |
| Operator portal | https://funded.honeycombcredit.com/admin |
| Audit log (every action, every run) | https://github.com/tylerhoneycomb/case-study-generator/issues |
| Failures only | [Issues filtered to `error`](https://github.com/tylerhoneycomb/case-study-generator/issues?q=is%3Aissue+label%3Aerror) |
| Workflow logs | https://github.com/tylerhoneycomb/case-study-generator/actions |
| Cron heartbeat | [`.state/detection-log.md`](../.state/detection-log.md) |

---

## Getting access

1. **Get added as a repository collaborator.** Write permission is
   sufficient. Collaborator status *is* the authorization model — the
   workflows check it on every dispatch.
2. **Create a fine-grained GitHub PAT** at
   [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new).
   Resource owner `tylerhoneycomb`; repository access limited to
   `case-study-generator`; permissions **Issues → Read and write**.
3. **Paste it into the portal** at `/admin`. It is stored in your own
   browser's localStorage and sent only to `api.github.com`. There is no
   backend to send it to.
4. **Confirm the wiring with a free action first:** run **Inspect** against
   any campaign slug. It spends nothing and commits nothing.

To revoke someone's access, remove them from the repo's collaborator list.
That invalidates the workflow's auth check on anything they post from that
moment on. Rotating the PAT in GitHub kills it everywhere it is stored.

---

## Publishing a case study

Four routes, same pipeline, same audit trail. Pick by how much input you have.

### From the portal (default)

`/admin` → **Generate** → paste the Honeycomb campaign slug (the tail of
`invest.honeycombcredit.com/campaigns/<slug>`, case-sensitive). The portal
opens a tracking issue and links you to it; progress lands there as comments.

### From a slash command

Comment on any issue or PR in the repo:

```
/funded generate <campaign-slug>
/funded redraft <case-study-slug> [feedback…]
/funded delete <case-study-slug>
/funded status
/funded cost-estimate <slug…>
/funded inspect <campaign-slug>
```

### From an Issue Form

Issues → New → **Backfill case studies** (many slugs at once, with an
optional per-day rate override) or **Redraft with feedback** (long-form
feedback that would be unwieldy in a comment).

### From the command line

Needs the environment from [`.env.example`](../.env.example).

```bash
npx tsx scripts/resolve.ts "Biz Name" ...    # name → slug — FREE
npx tsx scripts/inspect.ts <slug>            # diagnostic, no spend
npx tsx scripts/generate.ts <slug>           # ~$0.45
npx tsx scripts/redraft.ts <slug> --feedback="..."
npx tsx scripts/delete.ts <slug>
npx tsx scripts/backfill.ts --slugs="A\nB\nC" [--force] [--dry-run] [--rate=N]
npx tsx scripts/detect.ts [--dry-run]        # the cron entry point
```

### When you have a name but not a slug

Run `scripts/resolve.ts` **first**. It answers "does this exist / is it
funded / what is the slug?" with one free PostHog query — no Anthropic
spend, no Actions run.

```bash
npx tsx scripts/resolve.ts "The Ladies Room" "Sigma Snacks"
```

It exits non-zero unless every name resolves to exactly one fundable
campaign, so it doubles as a gate: resolve the names, then paste the
fundable slugs into a Backfill. This keeps name-hunting off the paid
generation path — a name that does not exist or never funded costs nothing
and never fires a doomed pipeline run.

Exit codes: `0` all names resolved · `1` something was not found, not
fundable, or ambiguous · `2` no names supplied.

---

## Redrafting well

A redraft without feedback is just a re-roll and costs the same ~$0.45.
Feedback that names specific patterns and specific paragraphs is what
actually steers the model:

> Cut the three stacked tricolons in the use-of-funds paragraph. Lead with
> the no-equity angle. Add a partial-funding sentence in Beat 4.

The narrative rules the model is working against live in
`prompts/case-study-prompt.md` — quoting a section number in your feedback
works well.

---

## Pausing and resuming the cron

The schedule lives in `.github/workflows/detect.yml`.

**To resume:** uncomment the `schedule:` block. The two slots are
`'47 4 * * *'` and `'23 11 * * *'` (00:47 and 07:23 EDT). Both are
deliberately off the `:00`/`:30` spikes, and there are two of them because
GitHub drops or delays scheduled runs under load. Detection is idempotent,
so a redundant run costs nothing.

**To pause:** comment the `schedule:` block out again. Leave
`workflow_dispatch` in place either way.

**To run detection once while paused:** Actions → Detect → *Run workflow*.
Set the `dry-run` input to `true` to scan without generating.

Expect roughly $0.45 per case study generated, capped at one per day by the
rate limit (see the caveat in [ARCHITECTURE.md §8](./ARCHITECTURE.md#8-state)).

---

## Costs and limits

| Action | Cost | Counts against rate limit |
|---|---|---|
| Generate, Redraft | ~$0.45 | Yes |
| Backfill | ~$0.45 per slug | Yes (override up to 10/day) |
| Inspect, Delete, Status, Cost-estimate, Resolve | $0 | No |

Default cap is **1 generation per UTC day** across all triggers. The Backfill
Issue Form can raise it to **10/day** for that run only. Work past the cap is
deferred and labelled `queued`.

Before a large backfill, price it first:

```
/funded cost-estimate <slug-a> <slug-b> <slug-c>
```

---

## Reading the tracking issue

Every operation opens (or reuses) a GitHub Issue, and the labels are the
outcome at a glance:

| Label | What it means | What to do |
|---|---|---|
| `published` | Generated and committed | Nothing — check the live page |
| `humanization-warning` | Published, but the copy failed the AI-tells validator twice | **Read it.** Redraft with feedback naming the flagged patterns |
| `queued` | Deferred by the rate limit | Nothing — a later run picks it up, or force it manually |
| `error` | The pipeline failed | See troubleshooting below |
| `deleted` | Case study removed | Reversible with `git revert` on the deletion commit |

`humanization-warning` is the one that needs a human. The pipeline retries
once and then publishes regardless, so the page is live with copy that
tripped the validator.

---

## Troubleshooting

**Start here, in order:**

1. **The tracking issue.** Failures write the error message into the issue
   comments in plain text. Most are content-validation problems and are
   self-explanatory.
2. **The Actions tab.** The underlying workflow run log, for anything the
   issue does not explain.
3. **`.state/detection-log.md`.** Confirms whether the cron ran at all and
   what it saw — one row per run, including quiet days.

### Common failures

**Scrape validation failed.** `CampaignSchema` rejected the payload —
usually Honeycomb's `__NEXT_DATA__` shape changed. Run
`npx tsx scripts/inspect.ts <slug>` to see what is actually in the blob, then
fix `scripts/lib/scrape.ts`. Free to diagnose.

**Claude output failed validation.** The response did not parse as JSON or
missed a required key of the 14. Usually transient — retry once. If it
repeats for one campaign, that campaign's input is likely unusual (a very
long summary, missing fields); inspect it.

**Nothing published and no issue opened.** Check whether the campaign was
already published — `listAllCampaignSlugs()` filters existing case studies
out before the rate-limit gate, silently and by design. Then check whether
the cron is paused (it currently is).

**The cron ran but nothing deployed.** A push authenticated with the default
`GITHUB_TOKEN` does not trigger `push:` workflows. `detect.yml` dispatches
`deploy.yml` explicitly after a successful push; if that step was skipped,
the push found nothing to push. Run Deploy manually from the Actions tab.

**Rate limit hit unexpectedly.** Note that the ledger is not committed
between runs, so each workflow invocation starts from a fresh budget — the
real-world limit is more permissive than "1/day" implies. See
[ARCHITECTURE.md §8](./ARCHITECTURE.md#8-state).

---

## Local development

```bash
nvm use            # Node 20+
npm install
npm run dev        # http://localhost:4321
npm run build      # static output to dist/
npm run typecheck  # astro sync && tsc --noEmit
npm test           # vitest run — 77 tests
```

`npm run typecheck` and `npm test` both gate every deploy, so run them before
pushing. Copy `.env.example` to `.env` and fill it in to run the agent CLIs
locally; in CI the same names are supplied as repository Actions secrets.
