import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { queryHealth, querySnapshot, queryTrend, epochMs } from '../../src/api/queries.js';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM events');
  await env.DB.exec('DELETE FROM users');
  await env.DB.exec('DELETE FROM user_active_days');
});

const EPOCH_ISO = '2026-04-24';
const EPOCH_MS = epochMs(EPOCH_ISO);
const NOW = Date.UTC(2026, 4, 12, 12, 0, 0); // 2026-05-12 12:00 UTC

async function insertEvent(row: {
  request_id: string;
  event: string;
  ts: number;
  level?: string | null;
  org?: string | null;
  user_hash?: string | null;
  client_id?: string | null;
  total_ms?: number | null;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO events
       (request_id, event, ts, level, org, user_hash, client_id, total_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      row.request_id,
      row.event,
      row.ts,
      row.level ?? null,
      row.org ?? 'unfoldingWord',
      row.user_hash ?? 'a'.repeat(64),
      row.client_id ?? 'web',
      row.total_ms ?? null
    )
    .run();
}

async function insertUser(row: {
  user_hash: string;
  org?: string;
  client_id?: string;
  first_seen_ts: number;
  last_seen_ts?: number;
  days_active_count?: number;
  last_active_day?: number;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users
       (user_hash, org, client_id, first_seen_ts, last_seen_ts,
        days_active_count, last_active_day)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      row.user_hash,
      row.org ?? 'unfoldingWord',
      row.client_id ?? 'web',
      row.first_seen_ts,
      row.last_seen_ts ?? row.first_seen_ts,
      row.days_active_count ?? 1,
      row.last_active_day ?? 20260424
    )
    .run();
}

async function insertActiveDays(user_hash: string, org: string, days: number[]): Promise<void> {
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO user_active_days (user_hash, org, day) VALUES (?, ?, ?)`
  );
  for (const d of days) {
    await stmt.bind(user_hash, org, d).run();
  }
}

describe('queryHealth', () => {
  it('reports down when no events in 5min window', async () => {
    await insertEvent({ request_id: 'r1', event: 'request_received', ts: NOW - 10 * 60_000 });
    const health = await queryHealth(env.DB, NOW);
    expect(health.status).toBe('down');
    expect(health.events_last_5m).toBe(0);
  });

  it('reports up with low error rate', async () => {
    await insertEvent({ request_id: 'r1', event: 'request_received', ts: NOW - 60_000 });
    await insertEvent({ request_id: 'r2', event: 'request_received', ts: NOW - 30_000 });
    const health = await queryHealth(env.DB, NOW);
    expect(health.status).toBe('up');
    expect(health.events_last_5m).toBe(2);
    expect(health.error_rate_5m_pct).toBe(0);
    expect(health.last_event_ts).toBe(NOW - 30_000);
  });

  it('reports degraded when error rate >= 2%', async () => {
    for (let i = 0; i < 99; i++) {
      await insertEvent({ request_id: `r${i}`, event: 'request_received', ts: NOW - 60_000 });
    }
    for (let i = 0; i < 3; i++) {
      await insertEvent({
        request_id: `e${i}`,
        event: 'request_error',
        level: 'error',
        ts: NOW - 60_000,
      });
    }
    const health = await queryHealth(env.DB, NOW);
    expect(health.status).toBe('degraded');
    expect(health.error_rate_5m_pct).toBeGreaterThanOrEqual(2);
  });
});

describe('querySnapshot', () => {
  it('returns zeroed snapshot when DB is empty', async () => {
    const snap = await querySnapshot(env.DB, EPOCH_ISO, NOW);
    expect(snap.distinct_users_all_time).toBe(0);
    expect(snap.distinct_users_30d).toBe(0);
    expect(snap.distinct_users_fixed_epoch).toBe(0);
    expect(snap.returning_users).toBe(0);
    expect(snap.login_count).toBe(0);
    expect(snap.chat_total_ms_p50).toBeNull();
    expect(snap.chat_total_ms_p95).toBeNull();
    expect(snap.error_rate_1h_pct).toBe(0);
    expect(snap.chat_busy_reject_rate_1h_pct).toBe(0);
    expect(snap.epoch_iso).toBe(EPOCH_ISO);
    expect(snap.generated_at_ts).toBe(NOW);
  });

  it('distinct_users_fixed_epoch excludes users with first_seen_ts before epoch', async () => {
    await insertUser({ user_hash: 'a'.repeat(64), first_seen_ts: EPOCH_MS - 1 });
    await insertUser({
      user_hash: 'b'.repeat(64),
      first_seen_ts: EPOCH_MS,
      org: 'wordcollective',
    });
    await insertUser({
      user_hash: 'c'.repeat(64),
      first_seen_ts: EPOCH_MS + 86_400_000,
      org: 'unfoldingWord',
      client_id: 'whatsapp',
    });
    const snap = await querySnapshot(env.DB, EPOCH_ISO, NOW);
    expect(snap.distinct_users_all_time).toBe(3);
    expect(snap.distinct_users_fixed_epoch).toBe(2);
  });

  it('distinct_users_30d counts (user_hash, org) pairs - same hash in two orgs counts as 2', async () => {
    // Same user_hash, two different orgs — must count as 2 to match the
    // canonical user key used by users.PRIMARY KEY (user_hash, org) and the
    // all-time / fixed-epoch counters. Regression guard: PR #3 review.
    const sharedHash = 'a'.repeat(64);
    await insertEvent({
      request_id: 'r1',
      event: 'request_received',
      ts: NOW - 5 * 86_400_000,
      user_hash: sharedHash,
      org: 'unfoldingWord',
    });
    await insertEvent({
      request_id: 'r2',
      event: 'request_received',
      ts: NOW - 5 * 86_400_000,
      user_hash: sharedHash,
      org: 'wordcollective',
    });
    const snap = await querySnapshot(env.DB, EPOCH_ISO, NOW);
    expect(snap.distinct_users_30d).toBe(2);
  });

  it('distinct_users_30d counts distinct users in events from last 30 days', async () => {
    // hash A: event inside 30d window
    await insertEvent({
      request_id: 'r1',
      event: 'request_received',
      ts: NOW - 5 * 86_400_000,
      user_hash: 'a'.repeat(64),
    });
    // hash B: event inside 30d window
    await insertEvent({
      request_id: 'r2',
      event: 'request_received',
      ts: NOW - 20 * 86_400_000,
      user_hash: 'b'.repeat(64),
    });
    // hash C: event outside 30d window (35 days back)
    await insertEvent({
      request_id: 'r3',
      event: 'request_received',
      ts: NOW - 35 * 86_400_000,
      user_hash: 'c'.repeat(64),
    });
    const snap = await querySnapshot(env.DB, EPOCH_ISO, NOW);
    expect(snap.distinct_users_30d).toBe(2);
  });

  it('returning_users counts users with days_active_count >= 2', async () => {
    await insertUser({
      user_hash: 'a'.repeat(64),
      first_seen_ts: EPOCH_MS,
      days_active_count: 1,
    });
    await insertUser({
      user_hash: 'b'.repeat(64),
      first_seen_ts: EPOCH_MS,
      days_active_count: 2,
      org: 'wordcollective',
    });
    await insertUser({
      user_hash: 'c'.repeat(64),
      first_seen_ts: EPOCH_MS,
      days_active_count: 5,
      org: 'unfoldingWord',
      client_id: 'whatsapp',
    });
    const snap = await querySnapshot(env.DB, EPOCH_ISO, NOW);
    expect(snap.returning_users).toBe(2);
  });

  it('login_count equals total rows in user_active_days', async () => {
    await insertActiveDays('a'.repeat(64), 'unfoldingWord', [20260424, 20260425, 20260426]);
    await insertActiveDays('b'.repeat(64), 'wordcollective', [20260424, 20260425]);
    const snap = await querySnapshot(env.DB, EPOCH_ISO, NOW);
    expect(snap.login_count).toBe(5);
  });

  it('chat latency p50/p95 are computed only over process_chat_complete within 1h', async () => {
    // Inside 1h window: 100, 200, ..., 1000 (10 values).
    for (let i = 1; i <= 10; i++) {
      await insertEvent({
        request_id: `r${i}`,
        event: 'process_chat_complete',
        ts: NOW - 60_000,
        total_ms: i * 100,
      });
    }
    // Outside 1h window: should be excluded.
    await insertEvent({
      request_id: 'old',
      event: 'process_chat_complete',
      ts: NOW - 2 * 60 * 60_000,
      total_ms: 999_999,
    });
    // Different event type: should be excluded.
    await insertEvent({
      request_id: 'other',
      event: 'request_received',
      ts: NOW - 60_000,
      total_ms: 999_999,
    });
    const snap = await querySnapshot(env.DB, EPOCH_ISO, NOW);
    expect(snap.chat_total_ms_p50).toBe(550);
    expect(snap.chat_total_ms_p95).toBe(955);
  });

  it('error_rate_1h_pct = errors / total within trailing hour', async () => {
    for (let i = 0; i < 8; i++) {
      await insertEvent({ request_id: `r${i}`, event: 'request_received', ts: NOW - 30 * 60_000 });
    }
    for (let i = 0; i < 2; i++) {
      await insertEvent({
        request_id: `e${i}`,
        event: 'request_error',
        level: 'error',
        ts: NOW - 30 * 60_000,
      });
    }
    const snap = await querySnapshot(env.DB, EPOCH_ISO, NOW);
    expect(snap.error_rate_1h_pct).toBe(20);
  });

  it('chat_busy_reject_rate_1h_pct = rejects / request_received within 1h', async () => {
    for (let i = 0; i < 4; i++) {
      await insertEvent({ request_id: `r${i}`, event: 'request_received', ts: NOW - 30 * 60_000 });
    }
    await insertEvent({
      request_id: 'rej',
      event: 'chat_busy_final_reject',
      ts: NOW - 30 * 60_000,
    });
    const snap = await querySnapshot(env.DB, EPOCH_ISO, NOW);
    expect(snap.chat_busy_reject_rate_1h_pct).toBe(25);
  });
});

describe('queryTrend', () => {
  it('returns N points oldest-first with nulls for empty days', async () => {
    const series = await queryTrend(env.DB, 'distinct_users', 7, NOW);
    expect(series.metric).toBe('distinct_users');
    expect(series.days).toBe(7);
    expect(series.points.length).toBe(7);
    expect(series.points.every((p) => p.value === null)).toBe(true);
    // Last point is "today" (NOW's UTC day), first is 6 days back, oldest-first.
    expect(series.points[series.points.length - 1]?.day).toBe(20260512);
    expect(series.points[0]?.day).toBe(20260506);
  });

  it('distinct_users trend counts (user_hash, org) pairs per day, not just user_hash', async () => {
    // Regression guard for the PR #3 review: ensure trend semantics match
    // the snapshot semantics. Same hash in two orgs on the same day = 2.
    const dayA = Date.UTC(2026, 4, 10, 12, 0, 0); // 20260510
    const sharedHash = 'a'.repeat(64);
    await insertEvent({
      request_id: 'r1',
      event: 'request_received',
      ts: dayA,
      user_hash: sharedHash,
      org: 'unfoldingWord',
    });
    await insertEvent({
      request_id: 'r2',
      event: 'request_received',
      ts: dayA,
      user_hash: sharedHash,
      org: 'wordcollective',
    });
    const series = await queryTrend(env.DB, 'distinct_users', 7, NOW);
    const byDay = new Map(series.points.map((p) => [p.day, p.value]));
    expect(byDay.get(20260510)).toBe(2);
  });

  it('distinct_users trend buckets users by UTC day', async () => {
    const dayA = Date.UTC(2026, 4, 10, 12, 0, 0); // 20260510
    const dayB = Date.UTC(2026, 4, 11, 12, 0, 0); // 20260511
    await insertEvent({
      request_id: 'r1',
      event: 'request_received',
      ts: dayA,
      user_hash: 'a'.repeat(64),
    });
    await insertEvent({
      request_id: 'r2',
      event: 'request_received',
      ts: dayA,
      user_hash: 'b'.repeat(64),
    });
    await insertEvent({
      request_id: 'r3',
      event: 'request_received',
      ts: dayB,
      user_hash: 'a'.repeat(64),
    });
    const series = await queryTrend(env.DB, 'distinct_users', 7, NOW);
    const byDay = new Map(series.points.map((p) => [p.day, p.value]));
    expect(byDay.get(20260510)).toBe(2);
    expect(byDay.get(20260511)).toBe(1);
    expect(byDay.get(20260512)).toBeNull();
  });

  it('error_rate trend returns percent per day', async () => {
    const dayA = Date.UTC(2026, 4, 10, 12, 0, 0);
    for (let i = 0; i < 9; i++) {
      await insertEvent({ request_id: `r${i}`, event: 'request_received', ts: dayA });
    }
    await insertEvent({ request_id: 'e1', event: 'request_error', level: 'error', ts: dayA });
    const series = await queryTrend(env.DB, 'error_rate', 7, NOW);
    const byDay = new Map(series.points.map((p) => [p.day, p.value]));
    expect(byDay.get(20260510)).toBe(10);
  });

  it('p95_latency trend computes p95 per UTC day from chat completes', async () => {
    const dayA = Date.UTC(2026, 4, 10, 12, 0, 0);
    for (let i = 1; i <= 20; i++) {
      await insertEvent({
        request_id: `r${i}`,
        event: 'process_chat_complete',
        ts: dayA,
        total_ms: i * 10,
      });
    }
    const series = await queryTrend(env.DB, 'p95_latency', 7, NOW);
    const byDay = new Map(series.points.map((p) => [p.day, p.value]));
    expect(byDay.get(20260510)).toBeGreaterThan(180);
    expect(byDay.get(20260510)).toBeLessThanOrEqual(200);
  });
});

describe('epochMs', () => {
  it('parses YYYY-MM-DD as UTC midnight', () => {
    expect(epochMs('2026-04-24')).toBe(Date.UTC(2026, 3, 24));
  });

  it('throws on invalid input', () => {
    expect(() => epochMs('not-a-date')).toThrow();
  });
});
