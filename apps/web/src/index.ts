import { Hono } from 'hono';
import { VERSION } from './config/version.js';
import { tailHandler } from './tail/index.js';
import { apiRoutes } from './api/routes.js';
import { scheduledHandler } from './scheduled/index.js';
import { consoleSink } from './scheduled/sink.js';
import { createZulipSink } from './zulip/index.js';
import type { Sink } from './config/sink.js';

type Env = {
  ENVIRONMENT: string;
  TELEMETRY_EPOCH: string;
  PII_HASH_SALT: string;
  DB: D1Database;
  // Scheduled-handler config: reconciliation backfill calls the Workers
  // Observability Telemetry API. CF_API_TOKEN is a per-env secret; the
  // other two come from [vars] in wrangler.toml.
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  SOURCE_WORKER_NAME: string;
  // Zulip delivery — all per-env secrets (set via `wrangler secret put`).
  // Optional so `wrangler dev` and tests fall back to the console sink
  // when secrets aren't configured.
  ZULIP_SITE?: string;
  ZULIP_BOT_EMAIL?: string;
  ZULIP_BOT_TOKEN?: string;
  ZULIP_STREAM?: string;
  ZULIP_TOPIC?: string;
  // SvelteKit static dashboard, served via Workers static assets binding.
  // Optional so vitest-pool-workers integration tests (which don't ship
  // the dashboard build) still run.
  ASSETS?: Fetcher;
};

// Pick the delivery sink based on env config. All five Zulip values
// must be present to opt into Zulip — anything else falls back to the
// console sink so dev/test runs don't need a real Zulip stream.
function selectSink(env: Env): Sink {
  if (
    env.ZULIP_SITE &&
    env.ZULIP_BOT_EMAIL &&
    env.ZULIP_BOT_TOKEN &&
    env.ZULIP_STREAM &&
    env.ZULIP_TOPIC
  ) {
    return createZulipSink({
      site: env.ZULIP_SITE,
      botEmail: env.ZULIP_BOT_EMAIL,
      botToken: env.ZULIP_BOT_TOKEN,
      stream: env.ZULIP_STREAM,
      topic: env.ZULIP_TOPIC,
    });
  }
  return consoleSink;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) =>
  c.json({
    status: 'healthy',
    version: VERSION,
    environment: c.env.ENVIRONMENT,
    epoch: c.env.TELEMETRY_EPOCH,
  })
);

app.route('/api', apiRoutes);

// Anything under /api that didn't match a real route is a typo or a
// removed endpoint — return a proper 404 instead of falling through to
// the catch-all and serving the SPA's index.html. Without this guard,
// `GET /api/typo` would respond 200 with HTML and the caller would
// blow up parsing JSON.
app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

// Static dashboard fallback. Page navigations only — Workers Static
// Assets only serves GET/HEAD anyway; the explicit method restriction
// makes the contract surface honest and stops accidental POST/PUT/
// PATCH/DELETE from being mistaken for successful SPA hits.
app.on(['GET', 'HEAD'], '*', (c) => {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.notFound();
});

const handler: ExportedHandler<Env> = {
  fetch: app.fetch,
  tail: tailHandler,
  scheduled: (controller, env, ctx) =>
    scheduledHandler(controller, env, ctx, { sink: selectSink(env) }),
};

export default handler;
