import type {
  EventHeatmapPayload,
  HealthSnapshot,
  MetricsSnapshot,
  SparklinesPayload,
  TrendMetric,
  TrendSeries,
} from '@bt-servant-telemetry/shared';

/**
 * Browser-side fetch client for the worker's /api routes. The dashboard
 * is served from the same origin as the API in production (Hono routes
 * + adapter-static via the ASSETS binding on one Worker), so relative
 * paths suffice. In `pnpm dev:ui`, Vite proxies /api/* to `wrangler dev`
 * on :8787 — see vite.config.ts.
 */

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`${path} returned HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export function fetchSnapshot(): Promise<MetricsSnapshot> {
  return getJson<MetricsSnapshot>('/api/snapshot');
}

export function fetchHealth(): Promise<HealthSnapshot> {
  return getJson<HealthSnapshot>('/api/health');
}

export function fetchTrend(metric: TrendMetric, days = 30): Promise<TrendSeries> {
  return getJson<TrendSeries>(`/api/trend?metric=${metric}&days=${days}`);
}

export function fetchSparklines(days = 30): Promise<SparklinesPayload> {
  return getJson<SparklinesPayload>(`/api/sparklines?days=${days}`);
}

export function fetchEventHeatmap(days = 30): Promise<EventHeatmapPayload> {
  return getJson<EventHeatmapPayload>(`/api/event-heatmap?days=${days}`);
}
