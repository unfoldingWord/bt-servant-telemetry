import { dayKeysForOffset, percentileSorted, startOfUtcDayMs } from './_time.js';
import type { PostIntent } from './sink.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export type DailyDigestSnapshot = {
  day: number;
  distinctUsers: number;
  totalEvents: number;
  errorRatePct: number;
  chatP95Ms: number | null;
};

export type DailyDigest = {
  yesterday: DailyDigestSnapshot;
  dayBefore: DailyDigestSnapshot;
};

/**
 * Daily digest (cron `0 9 * * *`). Yesterday's KPIs versus the day
 * before. "Yesterday" / "day before" are UTC calendar days relative to
 * `nowMs` — the cron fires once at 09:00 UTC, so this is unambiguous.
 *
 * Returns the computed digest plus the formatted PostIntent so callers
 * can hand the intent to a sink and use the raw numbers in tests.
 */
export async function runDailyDigest(
  db: D1Database,
  nowMs: number
): Promise<{ intent: PostIntent; digest: DailyDigest }> {
  const startToday = startOfUtcDayMs(nowMs);
  const yesterdayMs = startToday - ONE_DAY_MS;
  const dayBeforeMs = yesterdayMs - ONE_DAY_MS;
  const [yesterday, dayBefore] = await Promise.all([
    snapshotForDay(db, yesterdayMs),
    snapshotForDay(db, dayBeforeMs),
  ]);
  const digest: DailyDigest = { yesterday, dayBefore };
  return { intent: { kind: 'digest', markdown: formatDigest(digest) }, digest };
}

async function snapshotForDay(db: D1Database, dayStartMs: number): Promise<DailyDigestSnapshot> {
  const dayEndMs = dayStartMs + ONE_DAY_MS;
  const day = dayKeysForOffset(dayStartMs, [0])[0] as number;
  const [counts, distinct, latencies] = await Promise.all([
    eventCounts(db, dayStartMs, dayEndMs),
    distinctUsersForDay(db, day),
    chatLatencies(db, dayStartMs, dayEndMs),
  ]);
  const errorRatePct =
    counts.total === 0 ? 0 : Math.round((counts.errors / counts.total) * 10000) / 100;
  return {
    day,
    distinctUsers: distinct,
    totalEvents: counts.total,
    errorRatePct,
    chatP95Ms: percentileSorted(latencies, 95),
  };
}

async function eventCounts(
  db: D1Database,
  sinceMs: number,
  untilMs: number
): Promise<{ total: number; errors: number }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) AS errors
         FROM events WHERE ts >= ? AND ts < ? AND user_hash IS NOT NULL AND org IS NOT NULL`
    )
    .bind(sinceMs, untilMs)
    .first<{ total: number; errors: number | null }>();
  return { total: row?.total ?? 0, errors: row?.errors ?? 0 };
}

// Distinct users for a day = (user_hash, org) pairs in user_active_days
// for that day key. user_active_days is the deduped per-day source of
// truth populated by ingest, so this is order-independent and matches
// the canonical user key used everywhere else.
async function distinctUsersForDay(db: D1Database, dayKey: number): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM user_active_days WHERE day = ?`)
    .bind(dayKey)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function chatLatencies(db: D1Database, sinceMs: number, untilMs: number): Promise<number[]> {
  const { results } = await db
    .prepare(
      `SELECT total_ms FROM events
        WHERE event = 'process_chat_complete'
          AND total_ms IS NOT NULL
          AND ts >= ? AND ts < ?
        ORDER BY total_ms`
    )
    .bind(sinceMs, untilMs)
    .all<{ total_ms: number }>();
  return results.map((r) => r.total_ms);
}

function formatDigest(digest: DailyDigest): string {
  const { yesterday, dayBefore } = digest;
  return [
    `**Daily digest — ${formatDay(yesterday.day)}**`,
    line('Distinct users', yesterday.distinctUsers, dayBefore.distinctUsers),
    line('Total events', yesterday.totalEvents, dayBefore.totalEvents),
    line('Error rate', `${yesterday.errorRatePct}%`, `${dayBefore.errorRatePct}%`),
    line(
      'Chat p95',
      yesterday.chatP95Ms === null ? 'n/a' : `${yesterday.chatP95Ms}ms`,
      dayBefore.chatP95Ms === null ? 'n/a' : `${dayBefore.chatP95Ms}ms`
    ),
  ].join('\n');
}

function formatDay(dayKey: number): string {
  const y = Math.floor(dayKey / 10000);
  const m = Math.floor((dayKey % 10000) / 100);
  const d = dayKey % 100;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function line(label: string, today: number | string, prior: number | string): string {
  return `- ${label}: **${today}** _(prev ${prior})_`;
}
