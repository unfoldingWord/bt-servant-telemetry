# bt-servant-telemetry — Implementation Plan

> **Status:** Phases 1–7 **merged to `main`**. PR #2 (`be9c54f`) phases 1–3; PR #3 (`fccc4af`) phase 4; PR #4 (squash `d140d41`, 2026-05-12) phase 5 with one review-fix commit (`/api/*` 404 guard + drop misleading cohort delta arrows); PR #5 (squash `baa0609`, 2026-05-13) phase 6 with one review-fix commit (race-safe `INSERT OR IGNORE` dedupe); PR #6 (squash `aa90f70`, 2026-05-13) phase 7 with one review-fix commit (catch transport-level fetch rejects so a Zulip outage can't abort the sweep). From here on, **one PR per phase off `main`**.
>
> **Phase ledger:**
>
> - Phase 1 — Monorepo skeleton — ✅ done (in PR #2)
> - Phase 2 — D1 schema + redact + tail handler — ✅ done (in PR #2)
> - Phase 3 — Backfill script — ✅ done (in PR #2)
> - Phase 4 — API layer — ✅ done (in PR #3)
> - Phase 5 — Dashboard — ✅ done (in PR #4)
> - Phase 6 — Scheduled handlers — ✅ done (in PR #5)
> - Phase 7 — Zulip integration — ✅ done (in PR #6)
> - Phase 8 — Prod deploy (separately scoped; needs `CLOUDFLARE_API_TOKEN` GH secret + real D1 IDs in `wrangler.toml`; "Deploy to Dev" CI check failing until then is expected).
>
> **Path convention in this doc:** repo-relative paths are bare (`apps/web/...`); references to sibling repos use a leading `../` and are pointers to source-of-truth configs we cloned into this repo, not live runtime dependencies.

## Context

`bt-servant-worker` (a Cloudflare Workers chat orchestrator, multi-tenant, MCP-based) currently emits rich structured JSON logs but has no aggregated view of its own behavior. Operators have to query raw logs to answer basic questions like "how many distinct users have we served?", "is the error rate trending up?", or "is the system healthy right now?".

This project creates **bt-servant-telemetry**: a monorepo containing a single Cloudflare Worker that ingests those logs in real time, stores aggregated state in D1, exposes a sleek Svelte dashboard with a dominant flip-counter hero, and posts daily digests / alerts / milestone pings to a Zulip channel. Tooling and CI mirror `lasker-opening-service` (fitness functions, onion architecture via dependency-cruiser, multi-env wrangler) with the SvelteKit bundle-size reporting from `bt-servant-web-client`.

## Architecture summary

**One Worker, three roles, two storage tiers.**

```
bt-servant-telemetry/                (pnpm workspaces monorepo, single deployable Worker)
├── packages/shared/                 TS types: MetricsSnapshot, UserEvent, OrgKey, LogEvent
│                                    Shared eslint.config.js, tsconfig.base.json, prettierrc
├── apps/web/                        THE Worker — fetch + tail + scheduled handlers
│   ├── src/
│   │   ├── tail/                    tail(event) ingest → filter events → upsert D1
│   │   ├── ingest/                  Event-shape parsers, D1 upserts, aggregation helpers
│   │   ├── scheduled/               Cron dispatchers (digest / alert-sweeper / milestone)
│   │   ├── api/                     Hono routes for dashboard: /api/snapshot, /api/trend
│   │   ├── zulip/                   fetch-only client, digest/alert/milestone formatters
│   │   ├── config/                  TELEMETRY_EPOCH, thresholds, version.ts
│   │   └── sveltekit/               SvelteKit app (routes, lib, components)
│   ├── svelte.config.js             adapter-cloudflare, SSR + Worker entrypoint
│   ├── vite.config.ts
│   ├── wrangler.toml                Multi-env, D1 binding, tail_consumers on the worker side
│   └── migrations/                  D1 schema migrations
├── .github/workflows/ci.yml
├── .dependency-cruiser.js           Onion rules per app
└── pnpm-workspace.yaml
```

**Ingestion:** **Tail Worker**, not polling. Add `tail_consumers` to `bt-servant-worker`'s `wrangler.toml` pointing at this worker's name. `tail(events, env)` receives every log entry in near-real-time; the handler de-identifies (see PII section), filters by known `event` field, and upserts into D1.

**Backfill / reconciliation:** The Workers Observability Telemetry API (the `/cf-logs` path) is used for two purposes only:

- **Bootstrap backfill** — one-shot script (`apps/web/src/scripts/backfill.ts`, runnable via `wrangler dev` or a one-off `pnpm run backfill`) that queries the full retention window (3–7 days) on initial deploy, runs the same parse → de-identify → upsert pipeline as `tail`. Idempotent: `events` is unique on `(request_id, event, ts)`; `users` is unique on `(user_hash, org)`. Re-running is safe.
- **Daily reconciliation cron** (`0 3 * * *`) — re-runs the same backfill over the last 24h every night. Patches over tail-handler downtime, missed events, or schema drift without affecting the live path.

Users who appeared before the retention window at bootstrap are unrecoverable — `TELEMETRY_EPOCH` should be set to **the later of**: the configured launch date OR the earliest event timestamp visible in retention at bootstrap. That is the honest "since" for the all-time counter.

**Storage:** D1 only. Two tables (note: **no raw user_id ever stored** — see PII section):

- `users (user_hash, org, client_id, first_seen_ts, last_seen_ts, days_active_count, last_active_day, first_interaction_transition_ts, PRIMARY KEY (user_hash, org))`
- `events (request_id, event, ts, level, org, user_hash, client_id, total_ms, duration_ms, chat_type, transport, tool_name, server_id, PRIMARY KEY (request_id, event, ts))` with indexes on `(ts)`, `(event, ts)`, `(user_hash, ts)`, `(level, ts)`

Plus dedupe tables for Phase 6: `posted_alerts (alert_kind PK)` and `reached_milestones (milestone PK)`.

The dashboard runs pre-shaped aggregate queries directly against D1. If latency becomes a problem, wrap the API response in the Workers Cache API at 30s TTL — do NOT reintroduce a KV snapshot (racy under concurrent tail invocations, stale propagation).

**TELEMETRY_EPOCH** is a single config constant (default `2026-04-24`) representing the line in the sand. "All-time" on the dashboard = since this date.

## PII handling — non-negotiable

The current `bt-servant-worker` logs contain raw PII that must never reach our D1:

| Source field                                                                  | What it is                                                     | Treatment                                                                       |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `user_id` (top-level)                                                         | WhatsApp: raw E.164 phone (digits, no `+`); Web: raw email     | Hash to `user_hash` via HMAC-SHA-256 with `PII_HASH_SALT`                       |
| `extra.do_key`                                                                | `user:<org>:<user_id>` — embeds same PII                       | Discard; we have `org` separately                                               |
| `url` (top-level)                                                             | REST routes embed user_id in path: `/users/<id>/...`           | Drop the field, or regex-redact the `<id>` segment if we want method/path stats |
| `response` (top-level on `process_chat_complete`)                             | Full assistant reply text (up to 2KB) — conversational content | Drop entirely; not needed for any metric                                        |
| `code` (top-level on `code_execution_error`)                                  | User-supplied code                                             | Drop                                                                            |
| `args` (top-level on `mcp_tool_call_error`)                                   | May contain user search terms                                  | Drop                                                                            |
| `stack` (top-level on any error event)                                        | Multi-KB compiled-bundle stack trace                           | Drop                                                                            |
| `$workers.event.request.headers.cf-connecting-ip`, `x-real-ip`                | Client IP                                                      | Drop                                                                            |
| `$workers.event.request.cf.country/city/region/postalCode/latitude/longitude` | CF geo metadata                                                | Drop (geo aggregates can be reconstructed from `org` if needed later)           |
| `$workers.event.request.headers.cookie`, `user-agent`                         | Browser fingerprinting / session                               | Drop                                                                            |

**Hashing:**

- HMAC-SHA-256 keyed with secret `PII_HASH_SALT` (set via `wrangler secret put PII_HASH_SALT`, distinct value per env).
- Hash input: `${client_id}:${user_id}` to prevent any cross-channel collision (a phone with the same digits as an email's local-part won't collide).
- Output: hex-encoded, full 64 chars stored. Truncating to save bytes is a footgun — birthday-paradox collisions at 1M users start being non-trivial below 16 chars.
- **Salt is set once and never rotated.** Rotation breaks user-distinctness across the rotation boundary.

**Implementation point:** `apps/web/src/ingest/redact.ts` exports a single `redact(rawLogEntry, salt): CleanEvent` function used by both the `tail` handler and the `backfill` script. Whitelist parser: only the named fields are extracted; anything else (response text, stack traces, tool args, code bodies, CF runtime metadata) is dropped on the floor. Unit-tested against fixtures captured from real production logs (PII pre-stripped, hashes pre-computed against a known test salt). dependency-cruiser rule: nothing in `tail/` or `scheduled/` may write to D1 without going through `ingest/redact.ts` first.

**Optional follow-up (not in scope for this work):** open a PR against `bt-servant-worker` to redact at source — copy the URL-segment redaction the `baruch` worker already does, and add `client_id`-aware hashing of `user_id` at the logger. Better defense-in-depth, but our boundary handles it correctly even if that PR never lands.

## Metrics

Hero (flip counter, dominant center, user-toggleable window with **All-time as default**):

- Distinct users — all-time (since epoch), rolling 30d, fixed (epoch-only, same number as all-time at launch but diverges if epoch changes)

Secondary KPIs (KpiBarChart cards):

- Returning users (≥2 distinct days of activity from `users.days_active_count ≥ 2`)
- Login count (sum of `first_interaction`-transition events + subsequent distinct-day opens)
- p50 / p95 chat `total_ms` (from `events.total_ms` where event = `process_chat_complete`)
- Error rate % (`COUNT(*) WHERE level = 'error'` / total requests, trailing 1h)
- Chat-busy reject rate

Trend charts (TrendChart, multi-line, dual y-axis):

- Distinct users per day
- Error rate per day
- p95 latency per day

Health strip (top bar):

- "Up / Degraded / Down" pill — based on: events in last 5min > 0 AND error rate < 2% in last 5min
- Last event received timestamp

## Hero counter: Flip animation

Use **@pqina/flip** (MIT, ~8kb) — the airport split-flap board. Wrap as a Svelte 5 component (`apps/web/src/sveltekit/src/lib/components/FlipCounter.svelte`). Number-flow was rejected as too subtle.

Chrome around it mirrors ccai's `StatsOverview.svelte`: gradient card, trend delta badge below, three toggle pills ("All-time" default / "Last 30 days" / "Fixed from epoch").

## Dashboard stack (cloning ccai exactly where possible)

- Svelte 5 + SvelteKit 2 + **`@sveltejs/adapter-cloudflare`** (ccai uses adapter-node; we swap it for Cloudflare)
- Tailwind 4 via `@import 'tailwindcss'` in `app.css` with inline `@theme` block (no tailwind.config)
- ECharts 5 + `svelte-echarts` 1
- `mode-watcher` for dark mode
- `@pqina/flip` for the hero counter
- Copy verbatim from ccai (`../ccai/app/src/lib/components/...`):
  - `charts/KpiBarChart.svelte`
  - `charts/TrendChart.svelte`
  - `charts/theme.ts`
  - `StatsOverview.svelte` (used as card chrome around the flip counter)

**Access control:** Public read-only. No auth layer.

## Zulip integration

Worker `scheduled` handler routes by cron pattern to four jobs:

| Cron           | Job                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| `0 9 * * *`    | Daily digest — yesterday's KPIs, delta vs prior day, any unusual movement                                    |
| `0 3 * * *`    | Reconciliation backfill — re-ingest last 24h via Telemetry API to patch any tail gaps                        |
| `*/5 * * * *`  | Alert sweeper — post if error rate > 2% for last 10 min OR no events received in last 5 min (worker offline) |
| `*/15 * * * *` | Milestone watcher — post when hero counter newly crossed 100 / 500 / 1k / 5k / 10k / 25k / 50k               |

Alerts are debounced via a `posted_alerts` D1 table so the same breach doesn't spam every 5 min.
Milestones are de-duplicated via a `reached_milestones` D1 table.

**Transport:** single `fetch` POST to `${ZULIP_SITE}/api/v1/messages` with HTTP Basic auth (`ZULIP_BOT_EMAIL:ZULIP_BOT_TOKEN`), body is `type=stream&to=<stream>&topic=<topic>&content=<markdown>`. Zulip Markdown for formatting. No Python service, no SDK — explicitly not replicating fred-zulip-bot's FastAPI pattern, which was justified for receive-loop but unnecessary for send-only.

Secrets (set per env via `wrangler secret put`):
`ZULIP_BOT_EMAIL`, `ZULIP_BOT_TOKEN`, `ZULIP_SITE`, `ZULIP_STREAM`, `ZULIP_TOPIC`, `PII_HASH_SALT`, `CF_API_TOKEN` (for Observability Telemetry API used by backfill).

## Tooling (cloning lasker-opening-service)

**ESLint flat config** — cloned from `../lasker-opening-service/eslint.config.js`:

- `max-lines-per-function: 50`, `max-statements: 25`, `complexity: 10`, `max-depth: 4`, `max-nested-callbacks: 3`, `max-params: 5`
- `eslint-plugin-security/recommended`
- `no-console: warn` globally; allow `console.log` in `apps/*/src/services/**`, `tail/**`, `ingest/**`, `scheduled/**`, `scripts/**`
- Types layer has no internal deps
- **Add an override** for `apps/web/src/sveltekit/src/lib/components/charts/**/*.svelte`: `max-lines-per-function: 120` (keep complexity/depth at normal). Chart components are mostly declarative option objects; the escape valve is "extract option builders into sibling `.ts` helpers" — the per-file relaxation is only for the Svelte binding layer.

**dependency-cruiser** — cloned from `../lasker-opening-service/.dependency-cruiser.js`, paths adapted for monorepo. Per-app onion rules inside `apps/web/src/`:

- `tail`, `scheduled`, `api`, `sveltekit` cannot import from each other (only from `ingest`, `zulip`, `config`, `shared`)
- `ingest`, `zulip` cannot import from `tail`/`scheduled`/`api`/`sveltekit`
- `config` cannot import from business layers
- `shared` package has no deps on any app

**wrangler.toml** multi-env — mirror lasker's structure:

- Top-level `name`, `main`, `compatibility_date`, top-level `[observability]` at 100%
- `[env.dev]` (sampling 1.0) — consumes `bt-servant-worker-staging` upstream
- `[env.production]` (sampling 0.1 — higher than lasker's 0.01 because telemetry's own error rate matters to us) — consumes `bt-servant-worker` (top-level) upstream
- D1 bindings per env (separate databases)
- Lasker's three-tier dev/staging/prod was dropped after Phase 8 — staging served no use case here (dev consumes the staging upstream worker; there's no third upstream to mirror). Re-add if/when a real use case emerges.

**CI** — cloned from `../lasker-opening-service/.github/workflows/ci.yml`:

- Jobs: `security-audit` → `[version-check, lint, typecheck, architecture, test, build]` → `ci-pass` gate
- Version check: `apps/web/src/config/version.ts` must match `apps/web/package.json` version
- Architecture job runs `pnpm run architecture` (dependency-cruiser)
- Bundle-size step inside `build` (from bt-servant-web-client pattern) — top 10 largest files in `.svelte-kit/cloudflare/` written to `$GITHUB_STEP_SUMMARY`
- Separate workflows: `deploy-dev.yml` (auto on push to `main` after CI green), `deploy-prod.yml` (manual via workflow_dispatch with CI-pass preflight)

**Testing:** Vitest + `@cloudflare/vitest-pool-workers`. Integration tests assert:

- Tail handler ingesting a known log blob results in expected D1 rows AND no raw PII anywhere in any row
- API endpoints return correct aggregates over seeded D1 fixtures
- Zulip digest formatter produces expected markdown given a snapshot

**Package manager:** pnpm with `pnpm-workspace.yaml`.

## Implementation phases

1. **Monorepo skeleton** — pnpm workspace, shared package, root tsconfig/eslint/prettier/dependency-cruiser, empty `apps/web`, CI workflows wired to run green on empty code.
2. **D1 schema + redact + tail handler** — migration, `ingest/redact.ts` with unit tests against captured fixtures, tail handler consuming real events from `bt-servant-worker` dev, integration tests verifying no raw PII reaches D1.
3. **Backfill script** — Observability Telemetry API client, runs the same redact → upsert pipeline. Used both as one-shot bootstrap and as the daily reconciliation cron job.
4. **API layer** — Hono routes for snapshot / trend / health, aggregate queries.
5. **Dashboard** — SvelteKit routes, copy ccai chart components, wire FlipCounter (@pqina/flip), connect to API.
6. **Scheduled handlers** — digest, alert sweeper, milestone watcher, reconciliation backfill, debounce/dedupe tables.
7. **Zulip integration** — formatters, secrets config, end-to-end test against a throwaway Zulip stream.
8. **Prod deploy:** dev first with `tail_consumers` wired to bt-servant-worker staging; run bootstrap backfill; verify data and zero raw-PII rows in D1; then prod with `tail_consumers` wired to top-level bt-servant-worker. CI/CD: dev auto-deploys on merges to `main` (workflow_run gated on `event == 'push'`); prod is manual via workflow_dispatch with a CI-pass preflight.

## Verification

- `pnpm run lint && pnpm run check && pnpm run architecture && pnpm run test && pnpm run build` — all green at the root.
- **PII audit:** `wrangler d1 execute ... "SELECT user_hash FROM users LIMIT 100"` — every value must be 64 hex chars, no `@`, no leading digit-runs of length ≥10 (anti-phone), no email substrings. Same check on `events`. Already enforced in the test suite against a seeded D1.
- Run bootstrap backfill against dev: `pnpm run backfill -- --since=$TELEMETRY_EPOCH`. Confirm idempotency by running twice and checking row counts unchanged on second run.
- Deploy to dev. Trigger real traffic against `bt-servant-worker` dev. Confirm `users` + `events` rows appearing in D1 within seconds (not minutes). Confirm dashboard renders the hero flip counter with the correct all-time number.
- Toggle pills between All-time / Rolling 30d / Fixed — confirm the three derivations return plausible values.
- Simulate an error burst (deliberately induce 5xx in bt-servant-worker dev for 10 min) — confirm alert sweeper posts to Zulip within one cron tick.
- Cross the next milestone manually (reset `reached_milestones` row) — confirm milestone post.
- Wait for 9am cron — confirm daily digest posts with yesterday's snapshot.
- CI: push a PR, confirm all jobs pass; confirm bundle-size step summary renders; confirm dependency-cruiser catches a deliberate violating import.

## Open risks acknowledged

- **Log event-name stability:** we treat `event` field values as a schema. If `bt-servant-worker` renames an event, we lose that metric silently. Mitigation: the current event-name list lives in `packages/shared/src/log-events.ts` as a typed enum; unknown events are filtered at ingest. A follow-up addition: a unit test that parses a sample log bundle and fails on unknown events above a threshold rate.
- **Workers Logs retention:** 3–7 days. Everything that needs to persist longer must be captured live into D1 — especially per-user `first_seen_ts`. That's why the `users` table upserts eagerly.
- **@pqina/flip license:** MIT for the core; confirm no paid-tier features are pulled in before committing to it. If it's borderline, fall back to a ~60-line custom Svelte split-flap.
- **PII salt loss:** if `PII_HASH_SALT` is ever lost or rotated, all hashes before that point are uncorrelatable with hashes after. Mitigation: the salt is treated like a one-way migration value — backed up alongside production secrets, never rotated. If we ever need to rotate (e.g. suspected leak), accept the discontinuity and start a new epoch.
- **Pre-bootstrap users:** users active before the bootstrap backfill window (older than retention at deploy time) are simply absent from `users`. The all-time counter is honest about this because `TELEMETRY_EPOCH` is set to the earliest event we actually saw. A retroactive count of "users since the worker first launched" is not recoverable.
