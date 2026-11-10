# bt-servant-telemetry

Telemetry pipeline + dashboard + Zulip notifier for [bt-servant-worker](../bt-servant-worker).

A single Cloudflare Worker that:

- ingests `bt-servant-worker` logs in real time via a Tail Worker
- de-identifies user identifiers (HMAC-SHA-256 with a server-side secret salt) before storage
- aggregates KPIs into D1 (distinct users, returning users, error rate, p50/p95 latency)
- serves a SvelteKit dashboard with a flip-counter hero
- posts daily digests, alert-on-threshold-breach, and milestone pings to a Zulip channel

## Layout

```
apps/web              The Worker — fetch + tail + scheduled handlers, plus SvelteKit
packages/shared       Cross-app TypeScript types
```

## Scripts

```bash
pnpm install
pnpm run lint
pnpm run check
pnpm run architecture
pnpm run test
pnpm run build
```

## Contributing

New here? Start with [docs/onboarding.md](docs/onboarding.md): setup, running it locally, the `develop` → `main` branching model and the PR loop. Design and history are in [docs/implementation-plan.md](docs/implementation-plan.md); the rules Claude Code follows in this repo are in [CLAUDE.md](CLAUDE.md).
