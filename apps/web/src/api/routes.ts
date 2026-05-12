import { Hono } from 'hono';
import { queryHealth, querySnapshot, queryTrend } from './queries.js';
import type { TrendMetric } from '@bt-servant-telemetry/shared';

type Env = {
  TELEMETRY_EPOCH: string;
  DB: D1Database;
};

const VALID_METRICS: ReadonlySet<TrendMetric> = new Set([
  'distinct_users',
  'error_rate',
  'p95_latency',
]);
const MAX_TREND_DAYS = 90;
const DEFAULT_TREND_DAYS = 30;

function parseTrendDays(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_TREND_DAYS;
  // Reject anything that isn't a bare base-10 integer — parseInt would
  // otherwise accept "7foo" and "7.5" as 7, contradicting the 400 message.
  if (!/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  if (n < 1 || n > MAX_TREND_DAYS) return null;
  return n;
}

function isTrendMetric(value: string | undefined): value is TrendMetric {
  return value !== undefined && VALID_METRICS.has(value as TrendMetric);
}

export const apiRoutes = new Hono<{ Bindings: Env }>();

apiRoutes.get('/health', async (c) => {
  const snapshot = await queryHealth(c.env.DB, Date.now());
  return c.json(snapshot);
});

apiRoutes.get('/snapshot', async (c) => {
  const snapshot = await querySnapshot(c.env.DB, c.env.TELEMETRY_EPOCH, Date.now());
  return c.json(snapshot);
});

apiRoutes.get('/trend', async (c) => {
  const metricParam = c.req.query('metric');
  if (!isTrendMetric(metricParam)) {
    return c.json({ error: 'metric must be one of: distinct_users, error_rate, p95_latency' }, 400);
  }
  const days = parseTrendDays(c.req.query('days'));
  if (days === null) {
    return c.json({ error: `days must be an integer 1..${MAX_TREND_DAYS}` }, 400);
  }
  const series = await queryTrend(c.env.DB, metricParam, days, Date.now());
  return c.json(series);
});
