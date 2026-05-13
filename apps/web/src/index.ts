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
};

export default handler;
