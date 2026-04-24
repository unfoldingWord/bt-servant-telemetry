import { Hono } from 'hono';
import { VERSION } from './config/version.js';

type Env = {
  ENVIRONMENT: string;
  TELEMETRY_EPOCH: string;
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

export default app;
