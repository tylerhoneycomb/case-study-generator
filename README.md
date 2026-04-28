# funded.honeycombcredit.com

Collateral Development Agent v4.0. A static Astro + MDX site listing every
funded Honeycomb Credit campaign. The repo is the agent: GitHub Actions
detects newly funded campaigns daily, generates one MDX file per campaign via
the Claude API, runs a humanization validator, fetches the hero image, commits
the result, and GitHub Pages deploys.

See `collateral_agent_v4_scope.md` (in the design archive) for the full
architecture.

## Stack

- **Astro 5** with TypeScript (strict), Tailwind, MDX content collections
- **GitHub Pages** from a private repo (GitHub Pro)
- **GitHub Actions** for daily detection cron, on-demand operations, and
  Pages deploy
- **GitHub Issues + Issue Forms + comment slash commands** as the human
  control surface
- **Anthropic API** for case-study generation

## Local development

```bash
nvm use            # Node 20+
npm install
npm run dev        # http://localhost:4321
npm run build      # static output to dist/
npm run typecheck  # tsc --noEmit
```

## Repo layout

```
src/
  content/case-studies/   ← one .mdx per funded campaign (agent writes)
  content/config.ts       ← Zod schema; single source of truth
  pages/                  ← Astro routing
  layouts/                ← case study + index layouts
  components/             ← hero, metadata, CTA, JSON-LD emitter
public/
  og/                     ← hero / OG images, one per case study
  CNAME                   ← funded.honeycombcredit.com
scripts/
  detect.ts generate.ts redraft.ts delete.ts backfill.ts
  lib/scrape.ts claude.ts humanize.ts ratelimit.ts github.ts
.github/
  workflows/              ← deploy / detect (cron) / on-issue / on-comment
  ISSUE_TEMPLATE/         ← backfill, redraft-with-feedback
.state/
  observed-fundraising.json   ← detection state
  ratelimit.json              ← daily generation counter
prompts/
  case-study-prompt.md    ← carries forward from v3.3
```

## Operations

Once live, operate the agent via GitHub:

- **`/funded generate <slug>`** in any issue/PR comment — generate one case study
- **`/funded redraft <slug>`** — regenerate without feedback
- **`/funded delete <slug>`** — remove a published case study
- **`/funded status`** — queue depth, rate-limit usage, last cron
- **`/funded cost-estimate <slug…>`** — estimate $ before generating
- **New issue → Backfill** — multi-slug Issue Form with rate override and dry-run
- **New issue → Redraft with feedback** — slug + feedback textarea

## Build phases

This repo is being built in seven phases. See git log for phase commits.

1. Repo scaffolding and Astro skeleton (this commit)
2. Content schema + rendering
3. Core scripts (scrape, claude, humanize, ratelimit, github, CLIs)
4. GitHub Actions workflows + Issue Forms
5. Custom-domain finalization
6. Seed case study
7. Cutover (cron live, placeholder removed)
