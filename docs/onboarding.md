# Your first PR on bt-servant-telemetry

This guide takes you from an empty laptop to a merged pull request on this repo. It assumes you will write most of the code with Claude Code, and that you know how to test software better than most of us. Nothing here needs you to remember syntax.

If anything in this guide is wrong or unclear, that is a bug in the guide. Fix it in your PR, or tell Ian.

## What this repo is

A single Cloudflare Worker that watches bt-servant-worker's logs, strips out anything personal, keeps aggregate numbers in a D1 database, shows them on a dashboard, mirrors chat turns to PostHog, and posts digests to Zulip.

- Production dashboard: https://telemetry.btservant.ai/
- Dev dashboard (follows the `develop` branch): https://bt-servant-telemetry-dev.unfoldingword.workers.dev/
- Design and history: [implementation-plan.md](implementation-plan.md)
- Rules Claude Code follows in this repo: [../CLAUDE.md](../CLAUDE.md)

## One-time setup

You already have admin access to the GitHub repo, so no forking is needed. You push branches straight to this repo.

1. **Git and GitHub.** Install git. Set up an SSH key with GitHub if you have not: https://docs.github.com/en/authentication/connecting-to-github-with-ssh. Then:

   ```bash
   git clone git@github.com:unfoldingWord/bt-servant-telemetry.git
   cd bt-servant-telemetry
   ```

2. **Node and pnpm.** Node 20 or newer, and pnpm 9. The easiest way to get the exact pnpm this repo wants:

   ```bash
   node --version        # must print v20 or higher
   corepack enable       # ships with Node; turns on the pnpm pinned in package.json
   pnpm --version        # should print 9.x
   pnpm install
   ```

   On Windows, do all of this inside WSL (Windows Subsystem for Linux). The Cloudflare test runner is unreliable on native Windows.

3. **Local secrets.** Create `apps/web/.dev.vars`. It is git-ignored and never leaves your machine.

   ```
   PII_HASH_SALT=any-string-you-like-locally
   ```

   That one line is enough to run the dashboard and the tests. The other secrets (`POSTHOG_API_KEY`, `ANTHROPIC_API_KEY`, `ZULIP_*`, `CF_API_TOKEN`) are only needed to exercise PostHog, text scrubbing, Zulip or the backfill against real Cloudflare logs. Ask Ian for a dev value when an issue needs one. Never paste a real secret into a commit, an issue, a PR, or a chat with Claude.

4. **Claude Code.** Install it from https://claude.com/claude-code and run it from the repo root, so it reads `CLAUDE.md` automatically. That file holds the house rules; you do not need to repeat them in your prompts.

## Run it locally

Two terminals.

```bash
# terminal 1: fill the local database with fake data that exercises every tile
pnpm seed
# in another shell, once it says it is listening on 8788:
curl -X POST 'http://localhost:8788/?days=30&users=250'

# terminal 2: the real worker
pnpm dev
```

Open http://localhost:8787/ and you should see the dashboard with numbers in it. `GET /api/snapshot` on the same port returns the same numbers as JSON.

The checks that CI runs, so you can run them yourself first:

```bash
pnpm lint            # ESLint + Prettier
pnpm check           # TypeScript, including the tests, plus svelte-check
pnpm architecture    # dependency rules (for example: nothing writes to D1 without going through redact)
pnpm test            # vitest, runs inside a real Workers runtime with a real local D1
pnpm build           # SvelteKit build + a wrangler dry run
```

Heads up: the pre-commit hook runs the production dependency audit, lint, type checks, architecture, tests and build on every commit. The first commit of the day takes a few minutes. That is normal. Do not bypass it.

## How branches work here

```
feature branch ──PR──▶ develop ──release PR (Ian)──▶ main ──tag (Ian)──▶ production
                        │
                        └─▶ dev dashboard, automatically, after each merge
```

- Branch from `develop`. Open your PR against `develop`. That is the default, so GitHub will pick it for you.
- Never push to `develop` or `main` directly. Branch protection will stop you anyway.
- Releases to production are Ian's step. You never need to touch `main`.

## The PR loop, step by step

### 1. Pick an issue, or write one

Start from the open issues list. If the thing you want to do is not there yet (the PostHog backfill, for example), open an issue first with what you observed, what you expect, and how you would check it. Your QA instincts are exactly what a good issue needs. Ian will confirm scope before you build.

### 2. Make a branch

```bash
git checkout develop
git pull
git checkout -b fix/123-short-name     # type/issue-number-short-name
```

Branch types used here: `feat/`, `fix/`, `docs/`, `ci/`, `chore/`.

### 3. Let Claude Code do the work, with you steering

Start Claude Code in the repo root. A good opening prompt looks like this:

> Read CLAUDE.md and docs/implementation-plan.md. We are working on issue #123 (paste the issue body or the number). Before writing any code, tell me which files you think are involved and how you would verify the change. Write a failing test first, then make it pass.

Things that work well:

- Ask for the plan before the code. You will catch wrong assumptions early, which is what you do for a living.
- Ask it to write the test first and show you the test failing. If a test passes before the fix exists, it is not testing the fix.
- Ask "what could this break?" before you commit.
- When it says it ran the checks, run `pnpm test` yourself once. Trust, then verify.

Things to say no to:

- Any suggestion to use `--no-verify`, skip a check, or add `|| true` to a command.
- Catching an error and doing nothing with it. Every failure gets logged with context.
- Touching how user data is de-identified without talking to Ian first. `apps/web/src/ingest/redact.ts` is the one place personal data is stripped, and it is a whitelist on purpose.

### 4. Bump the version

Every PR bumps the version, even a docs PR. The version lives in two files that must match or CI fails:

- `apps/web/package.json`, the `version` field
- `apps/web/src/config/version.ts`, the `VERSION` constant

Patch (`0.6.1` to `0.6.2`) for fixes, docs and small changes. Minor (`0.6.1` to `0.7.0`) for new features. Ask Claude Code to do it: "bump the patch version in both places".

### 5. Commit and push

```bash
git add -A
git commit -m "fix(web): short description of the change (v0.6.2)"
git push -u origin fix/123-short-name
```

Commit titles follow `type(scope): what changed (vX.Y.Z)`. Look at `git log --oneline` for the pattern. Write a body too: what was wrong, what you changed, how you checked it.

### 6. Open the PR

```bash
gh pr create --base develop
```

Or use the GitHub website. The PR body should have three parts: a summary of the change, how you tested it, and `Issue #123` (not `Closes #123`; issues close after QA, not after merge).

### 7. Review

- CI runs automatically. Green is required. If it is red, click through to the failing job and paste the error to Claude Code.
- Ian runs a Codex review and posts the findings on the PR. Fix every finding, including the ones marked low. Push the fix and say the PR is ready for another look.
- When the review is clean, Ian approves and merges. A few minutes later the dev dashboard is running your change.

Check your change on the dev dashboard. That is the end of the PR, and the start of QA.

## Skills you can borrow

Ian's day-to-day Claude Code skills are published as a plugin so you can install them, try them, and change them. In Claude Code:

```
/plugin marketplace add unfoldingWord/uw-dev-skills
/plugin install uw-flow@uw-dev-marketplace
```

Then, for example, `/uw-flow:plan-issue 123` fetches the issue, makes the branch, and drafts a plan for you to approve before any code is written. `/uw-flow:push-and-pr` takes a finished branch through commit, push, CI and PR. `/uw-flow:explain` is for anything you want in plain language. The plugin's README lists all of them and the caveats; two were written before the `develop` branch existed, so read a skill before trusting it, and improve it with a PR to that repo if you like.

The same marketplace has `uw-dev`, Seth's shared commands and skills, including `cf-logs` for reading Cloudflare logs.

## Where things live

```
apps/web/src/
  tail/        receives bt-servant-worker's logs in real time
  ingest/      redact (PII whitelist), upsert into D1, session stitching, PostHog, text scrubbing
  backfill/    re-reads recent logs from Cloudflare and runs them through the same ingest path
  scheduled/   cron jobs: nightly reconciliation, alerts, milestones, Zulip digest
  api/         the JSON endpoints the dashboard reads (/api/snapshot and friends)
  sveltekit/   the dashboard UI
  zulip/       posting to Zulip
  scripts/     one-off tools: seed-dev (fake data), backfill
  config/      version and constants
apps/web/migrations/   D1 schema, one numbered SQL file per change, never edit an old one
apps/web/tests/        vitest, mirrors the src folders; fixtures/ has sample log events
packages/shared/       types shared between the worker and the UI
```

## Getting unstuck

- Ask Claude Code to explain any file, error or term in plain language. It is good at that.
- Ask Ian on Zulip. A screenshot or a pasted error beats a description.
- If the pre-commit hook fails on something you did not touch, say so in the PR. It happened to the production audit in November 2026 and the fix was a dependency bump, not your code.
