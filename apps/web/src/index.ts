import { Hono } from 'hono';
import { VERSION } from './config/version.js';
import { tailHandler } from './tail/index.js';

type Env = {
  ENVIRONMENT: string;
  TELEMETRY_EPOCH: string;
  PII_HASH_SALT: string;
  DB: D1Database;
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

const handler: ExportedHandler<Env> = {
  fetch: app.fetch,
  tail: tailHandler,
};

export default handler;
