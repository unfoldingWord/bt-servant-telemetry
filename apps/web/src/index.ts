import { Hono } from 'hono';
import { VERSION } from './config/version.js';
import { tailHandler } from './tail/index.js';
import { apiRoutes } from './api/routes.js';

type Env = {
  ENVIRONMENT: string;
  TELEMETRY_EPOCH: string;
  PII_HASH_SALT: string;
  DB: D1Database;
  // SvelteKit static dashboard, served via Workers static assets binding.
  // Optional so vitest-pool-workers integration tests (which don't ship
  // the dashboard build) still run.
  ASSETS?: Fetcher;
};

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

// Static dashboard fallback. Anything not matched above falls through to
// the SvelteKit-built SPA bound at ASSETS. Workers Static Assets handles
// SPA routing via `not_found_handling = "single-page-application"` in
// wrangler.toml, so deep links resolve to index.html and the client
// router takes over.
app.all('*', (c) => {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.notFound();
});

const handler: ExportedHandler<Env> = {
  fetch: app.fetch,
  tail: tailHandler,
};

export default handler;
