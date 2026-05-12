/**
 * API contract types shared between the Worker's /api routes and the
 * SvelteKit dashboard. Field names match the wire shape exactly.
 */

export type HealthStatus = 'up' | 'degraded' | 'down';

export type HealthSnapshot = {
  status: HealthStatus;
  last_event_ts: number | null;
  events_last_5m: number;
  error_rate_5m_pct: number;
};

/**
 * Hero + KPI payload. Windowed counters are all expressed in absolute
 * counts; rates are percentages (0–100). Nulls mean "no data in window".
 */
export type MetricsSnapshot = {
  // Hero — distinct users
  distinct_users_all_time: number;
  distinct_users_30d: number;
  distinct_users_fixed_epoch: number;

  // Secondary KPIs
  returning_users: number;
  login_count: number;
  chat_total_ms_p50: number | null;
  chat_total_ms_p95: number | null;
  error_rate_1h_pct: number;
  chat_busy_reject_rate_1h_pct: number;

  // Provenance
  epoch_iso: string;
  generated_at_ts: number;
};

export type TrendMetric = 'distinct_users' | 'error_rate' | 'p95_latency';

export type TrendPoint = {
  day: number; // yyyymmdd UTC
  value: number | null;
};

export type TrendSeries = {
  metric: TrendMetric;
  days: number;
  points: TrendPoint[];
};
