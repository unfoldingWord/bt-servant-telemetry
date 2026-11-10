# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## CRITICAL: Branching Model (develop → main)

Two long-lived branches:

- **`develop`** is the integration branch and the default branch. Every feature branch and every PR targets `develop`. The dev environment deploys automatically after CI passes on a push to `develop`. Bot review plus CI is enough to merge there.
- **`main`** is the release branch. It only ever receives `develop` (a release PR, "Release vX.Y.Z: develop → main") or a `hotfix/*` branch. Only the repo owner can merge to `main` (branch protection restricts pushes and requires a code-owner review; see `.github/CODEOWNERS`). Production deploys from `main` by tag.
- **Rule: `develop` is always releasable.** Work that is not ready to ship stays on its feature branch, or merges behind a flag that is off in production. Never cherry-pick into `main`; if something on `develop` must not ship, revert it on `develop` or flag it off, then release.
- **Hotfix:** branch from `main` as `hotfix/<name>`, PR into `main`, then open a PR from `main` into `develop` the same day so `develop` stays ahead of `main`.
- **Release:** merge the release PR, tag `v<version>` on the resulting `main` commit, dispatch the production deploy on that tag.
- **Merge methods:** feature PRs into `develop` are **squash**-merged (`develop` requires linear history). Release and hotfix PRs into `main` use a **merge commit**, never squash or rebase; a ruleset on `main` allows only merge commits. A squash would copy `develop`'s work into a new commit that `develop` never contains, so the branches would diverge and every later release PR would re-list already-shipped commits. With merge commits, the next release PR shows only what is new, and `git log --first-parent main` lists one commit per release. Never delete `develop` when merging a release PR.
- **Up to date before merge:** `develop` requires a PR branch to be current with `develop` before it merges (use "Update branch"), so two PRs that pass alone cannot break together. `main` does not, because `develop` never contains `main`'s release merge commits.

CI's `Release Source` job refuses a PR into `main` from any other branch. The production deploy (`deploy-prod.yml`) refuses to run on anything but a `v*` tag that is on `main`. `apps/web/tests/workflows-branching.test.ts` pins these triggers and guards.

### Ask Before Pushing

**ALWAYS ask the user before pushing changes.** Always create a feature branch and a PR against `develop`. Never push to `develop` or `main` directly.

## Deployments

All deployments go through CI/CD (GitHub Actions). **Never run `wrangler deploy` directly.**

- **Dev** (`deploy-dev.yml`): the integration environment. Deploys automatically after CI succeeds on a **push to `develop`** (i.e. after a PR merges into `develop`). It checks out the exact commit CI tested. PR branches never deploy, and CI runs for a release PR (whose head is also `develop`) do not deploy either.
- **Production** (`deploy-prod.yml`): manual `workflow_dispatch`, and only on a `v*` release tag that is on `main`. Any other ref is refused before anything deploys, and the `CI Pass` check on that commit must be green:

  ```bash
  gh workflow run deploy-prod.yml --ref v<version>
  ```

## Version Bumping and Release Tags

The service version is `apps/web/package.json` `version`, mirrored in `apps/web/src/config/version.ts` (`VERSION`); CI's `Version Sync Check` fails when they differ. Every PR bumps both on its branch, before the final push:

- **Patch**: bug fixes, docs, CI, minor tweaks
- **Minor**: new features, behavioral changes

Feature PRs into `develop` are not tagged. After a release PR (`develop` → `main`) or hotfix is merged, tag the resulting `main` commit and push the tag, then dispatch the production deploy on it:

```bash
git checkout main && git pull
git tag v<version>
git push origin v<version>
```

Tags are created on `main` only, never on `develop`.

## Project Overview

bt-servant-telemetry is a pnpm monorepo: `apps/web` is a Cloudflare Worker (Hono API, SvelteKit SPA, D1, tail consumer, scheduled jobs) and `packages/shared` holds shared types. See [docs/implementation-plan.md](docs/implementation-plan.md).

## Development Commands

- `pnpm dev` — run the web app locally
- `pnpm build` — build every package
- `pnpm test` — run every package's tests
- `pnpm check` — type checks (including `apps/web`'s test tsconfig and svelte-check)
- `pnpm lint` / `pnpm format:check` — ESLint and Prettier
- `pnpm architecture` — dependency-cruiser rules
