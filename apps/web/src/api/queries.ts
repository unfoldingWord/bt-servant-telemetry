import type {
  HealthSnapshot,
  HealthStatus,
  MetricsSnapshot,
  TrendMetric,
  TrendPoint,
  TrendSeries,
} from '@bt-servant-telemetry/shared';

/**
 * Pure D1 aggregate queries. Each function takes the database and any
 * window parameters explicitly; `now` is always injected by the caller so
 * tests can pin time without mocking globals.
 *
 * No PII enters or leaves this module — all reads are against already-
 * redacted columns. Onion: api → ingest is forbidden by depcruise; this
 * module exists in the api layer because its consumers are routes.
 */

const FIVE_MIN_MS = 5 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const HEALTH_ERROR_RATE_DEGRADED_PCT = 2;

// SQL projection from a ts (ms) column to a yyyymmdd UTC day key — must
// match utcDayKey() in ingest/upsert.ts and migration 0002.
const DAY_KEY_SQL = `
  CAST(strftime('%Y', ts / 1000, 'unixepoch') AS INTEGER) * 10000 +
  CAST(strftime('%m', ts / 1000, 'unixepoch') AS INTEGER) * 100 +
  CAST(strftime('%d', ts / 1000, 'unixepoch') AS INTEGER)
`;

export function epochMs(envEpochIso: string): number {
  const ms = Date.parse(`${envEpochIso}T00:00:00Z`);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid TELEMETRY_EPOCH: ${envEpochIso}`);
  }
  return ms;
}

function utcDayKey(ts: number): number {
  const d = new Date(ts);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

function dayKeyRangeDescending(nowMs: number, days: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < days; i++) {
    out.push(utcDayKey(nowMs - i * ONE_DAY_MS));
  }
  return out;
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const loVal = sortedAsc.at(lo) ?? null;
  if (lo === hi) return loVal;
  const hiVal = sortedAsc.at(hi) ?? 0;
  const frac = rank - lo;
  return Math.round((loVal ?? 0) * (1 - frac) + hiVal * frac);
}

function safeRatePct(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 10000) / 100;
}

// ===========================================
// HEALTH
// ===========================================

export async function queryHealth(db: D1Database, nowMs: number): Promise<HealthSnapshot> {
  const since = nowMs - FIVE_MIN_MS;
  const row = await db
    .prepare(
      `SELECT MAX(ts) AS last_event_ts,
              COUNT(*) AS events,
              SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) AS errors
         FROM events WHERE ts >= ?`
    )
    .bind(since)
    .first<{ last_event_ts: number | null; events: number; errors: number | null }>();

  const events = row?.events ?? 0;
  const errors = row?.errors ?? 0;
  const errorRatePct = safeRatePct(errors, events);
  return {
    status: deriveHealthStatus(events, errorRatePct),
    last_event_ts: row?.last_event_ts ?? null,
    events_last_5m: events,
    error_rate_5m_pct: errorRatePct,
  };
}

function deriveHealthStatus(eventsLast5m: number, errorRatePct: number): HealthStatus {
  if (eventsLast5m === 0) return 'down';
  if (errorRatePct >= HEALTH_ERROR_RATE_DEGRADED_PCT) return 'degraded';
  return 'up';
}

// ===========================================
// SNAPSHOT — hero + KPIs
// ===========================================

async function countAllTimeUsers(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>();
  return row?.n ?? 0;
}

async function countUsersSinceEpoch(db: D1Database, epoch: number): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE first_seen_ts >= ?`)
    .bind(epoch)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function countDistinctUsers30d(db: D1Database, nowMs: number): Promise<number> {
  // Counts distinct (user_hash, org) pairs to match the canonical user key
  // used by users.PRIMARY KEY and the all-time / fixed-epoch counters.
  // COUNT(DISTINCT user_hash) alone would collapse a hash that appears in
  // two orgs, causing this counter to disagree with the hero.
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT DISTINCT user_hash, org FROM events
          WHERE ts >= ? AND user_hash IS NOT NULL AND org IS NOT NULL
       )`
    )
    .bind(nowMs - 30 * ONE_DAY_MS)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function countReturningUsers(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE days_active_count >= 2`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function countLogins(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM user_active_days`).first<{ n: number }>();
  return row?.n ?? 0;
}

async function chatLatencyPercentiles(
  db: D1Database,
  nowMs: number
): Promise<{ p50: number | null; p95: number | null }> {
  const since = nowMs - ONE_HOUR_MS;
  const { results } = await db
    .prepare(
      `SELECT total_ms FROM events
        WHERE event = 'process_chat_complete'
          AND total_ms IS NOT NULL
          AND ts >= ?
        ORDER BY total_ms`
    )
    .bind(since)
    .all<{ total_ms: number }>();
  const vals = results.map((r) => r.total_ms);
  return { p50: percentile(vals, 50), p95: percentile(vals, 95) };
}

async function errorRate1hPct(db: D1Database, nowMs: number): Promise<number> {
  const since = nowMs - ONE_HOUR_MS;
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) AS errors
         FROM events WHERE ts >= ?`
    )
    .bind(since)
    .first<{ n: number; errors: number | null }>();
  return safeRatePct(row?.errors ?? 0, row?.n ?? 0);
}

async function chatBusyRejectRate1hPct(db: D1Database, nowMs: number): Promise<number> {
  const since = nowMs - ONE_HOUR_MS;
  const row = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN event = 'request_received' THEN 1 ELSE 0 END) AS attempts,
         SUM(CASE WHEN event = 'chat_busy_final_reject' THEN 1 ELSE 0 END) AS rejects
       FROM events WHERE ts >= ?`
    )
    .bind(since)
    .first<{ attempts: number | null; rejects: number | null }>();
  return safeRatePct(row?.rejects ?? 0, row?.attempts ?? 0);
}

export async function querySnapshot(
  db: D1Database,
  envEpochIso: string,
  nowMs: number
): Promise<MetricsSnapshot> {
  const epoch = epochMs(envEpochIso);
  const [allTime, fixed, d30, returning, logins, latency, errPct, rejectPct] = await Promise.all([
    countAllTimeUsers(db),
    countUsersSinceEpoch(db, epoch),
    countDistinctUsers30d(db, nowMs),
    countReturningUsers(db),
    countLogins(db),
    chatLatencyPercentiles(db, nowMs),
    errorRate1hPct(db, nowMs),
    chatBusyRejectRate1hPct(db, nowMs),
  ]);
  return {
    distinct_users_all_time: allTime,
    distinct_users_30d: d30,
    distinct_users_fixed_epoch: fixed,
    returning_users: returning,
    login_count: logins,
    chat_total_ms_p50: latency.p50,
    chat_total_ms_p95: latency.p95,
    error_rate_1h_pct: errPct,
    chat_busy_reject_rate_1h_pct: rejectPct,
    epoch_iso: envEpochIso,
    generated_at_ts: nowMs,
  };
}

// ===========================================
// TREND — per-day series
// ===========================================

async function trendDistinctUsersByDay(
  db: D1Database,
  sinceMs: number
): Promise<Map<number, number>> {
  // Counts distinct (user_hash, org) per day — same canonical key as the
  // hero counters so trend and snapshot stay consistent under multi-tenant
  // data. SQLite has no COUNT(DISTINCT a, b), so we project distinct pairs
  // in a subquery and count rows per day.
  const { results } = await db
    .prepare(
      `SELECT day, COUNT(*) AS n FROM (
         SELECT DISTINCT user_hash, org, ${DAY_KEY_SQL} AS day
           FROM events
          WHERE ts >= ? AND user_hash IS NOT NULL AND org IS NOT NULL
       )
       GROUP BY day`
    )
    .bind(sinceMs)
    .all<{ day: number; n: number }>();
  return new Map(results.map((r) => [r.day, r.n]));
}

async function trendErrorRateByDay(db: D1Database, sinceMs: number): Promise<Map<number, number>> {
  const { results } = await db
    .prepare(
      `SELECT ${DAY_KEY_SQL} AS day,
              COUNT(*) AS total,
              SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) AS errors
         FROM events WHERE ts >= ?
         GROUP BY day`
    )
    .bind(sinceMs)
    .all<{ day: number; total: number; errors: number | null }>();
  return new Map(results.map((r) => [r.day, safeRatePct(r.errors ?? 0, r.total)]));
}

async function trendP95LatencyByDay(db: D1Database, sinceMs: number): Promise<Map<number, number>> {
  const { results } = await db
    .prepare(
      `SELECT ${DAY_KEY_SQL} AS day, total_ms
         FROM events
        WHERE ts >= ?
          AND event = 'process_chat_complete'
          AND total_ms IS NOT NULL`
    )
    .bind(sinceMs)
    .all<{ day: number; total_ms: number }>();
  const buckets = new Map<number, number[]>();
  for (const row of results) {
    const arr = buckets.get(row.day) ?? [];
    arr.push(row.total_ms);
    buckets.set(row.day, arr);
  }
  const out = new Map<number, number>();
  for (const [day, vals] of buckets) {
    vals.sort((a, b) => a - b);
    const p95 = percentile(vals, 95);
    if (p95 !== null) out.set(day, p95);
  }
  return out;
}

async function loadTrendBuckets(
  db: D1Database,
  metric: TrendMetric,
  sinceMs: number
): Promise<Map<number, number>> {
  if (metric === 'distinct_users') return trendDistinctUsersByDay(db, sinceMs);
  if (metric === 'error_rate') return trendErrorRateByDay(db, sinceMs);
  return trendP95LatencyByDay(db, sinceMs);
}

export async function queryTrend(
  db: D1Database,
  metric: TrendMetric,
  days: number,
  nowMs: number
): Promise<TrendSeries> {
  const sinceMs = nowMs - days * ONE_DAY_MS;
  const buckets = await loadTrendBuckets(db, metric, sinceMs);
  const points: TrendPoint[] = dayKeyRangeDescending(nowMs, days)
    .reverse()
    .map((day) => ({ day, value: buckets.has(day) ? (buckets.get(day) as number) : null }));
  return { metric, days, points };
}
