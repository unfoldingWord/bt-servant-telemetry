import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runDailyDigest } from '../../src/scheduled/index.js';

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

// Cron fires at 09:00 UTC daily; we test against a representative now.
const NOW = Date.UTC(2026, 4, 12, 9, 0, 0); // 2026-05-12 09:00 UTC
const YESTERDAY_NOON = Date.UTC(2026, 4, 11, 12, 0, 0);
const DAY_BEFORE_NOON = Date.UTC(2026, 4, 10, 12, 0, 0);
const YESTERDAY_KEY = 20260511;
const DAY_BEFORE_KEY = 20260510;

async function insertEvent(row: {
  request_id: string;
  event: string;
  ts: number;
  level?: string | null;
  user_hash?: string | null;
  org?: string | null;
  total_ms?: number | null;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO events (request_id, event, ts, level, org, user_hash, total_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      row.request_id,
      row.event,
      row.ts,
      row.level ?? null,
      row.org ?? 'org-a',
      'user_hash' in row ? row.user_hash : 'a'.repeat(64),
      row.total_ms ?? null
    )
    .run();
}

async function markActive(userHash: string, org: string, day: number): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO user_active_days (user_hash, org, day) VALUES (?, ?, ?)`
  )
    .bind(userHash, org, day)
    .run();
}

describe('runDailyDigest', () => {
  it('returns zeroed snapshots when there is no activity', async () => {
    const { digest } = await runDailyDigest(env.DB, NOW);
    expect(digest.yesterday.day).toBe(YESTERDAY_KEY);
    expect(digest.yesterday.distinctUsers).toBe(0);
    expect(digest.yesterday.totalEvents).toBe(0);
    expect(digest.yesterday.errorRatePct).toBe(0);
    expect(digest.yesterday.chatP95Ms).toBeNull();
    expect(digest.dayBefore.day).toBe(DAY_BEFORE_KEY);
  });

  it('counts distinct (user_hash, org) per UTC calendar day from user_active_days', async () => {
    await markActive('u1', 'org-a', YESTERDAY_KEY);
    await markActive('u2', 'org-a', YESTERDAY_KEY);
    await markActive('u1', 'org-b', YESTERDAY_KEY); // same hash, different org → distinct
    await markActive('u3', 'org-a', DAY_BEFORE_KEY);

    const { digest } = await runDailyDigest(env.DB, NOW);
    expect(digest.yesterday.distinctUsers).toBe(3);
    expect(digest.dayBefore.distinctUsers).toBe(1);
  });

  it('computes error rate and p95 from yesterday-only events', async () => {
    // Yesterday: 2 errors out of 4 events = 50%
    await insertEvent({ request_id: 'r1', event: 'request_received', ts: YESTERDAY_NOON });
    await insertEvent({
      request_id: 'r2',
      event: 'mcp_tool_call_error',
      ts: YESTERDAY_NOON + 1000,
      level: 'error',
    });
    await insertEvent({
      request_id: 'r3',
      event: 'process_chat_complete',
      ts: YESTERDAY_NOON + 2000,
      total_ms: 100,
    });
    await insertEvent({
      request_id: 'r4',
      event: 'process_chat_complete',
      ts: YESTERDAY_NOON + 3000,
      level: 'error',
      total_ms: 500,
    });
    // Today (must not leak into yesterday's snapshot):
    await insertEvent({
      request_id: 'r5',
      event: 'process_chat_complete',
      ts: NOW + 1000,
      total_ms: 9000,
    });
    // Day before:
    await insertEvent({ request_id: 'r6', event: 'request_received', ts: DAY_BEFORE_NOON });

    const { digest } = await runDailyDigest(env.DB, NOW);
    expect(digest.yesterday.totalEvents).toBe(4);
    expect(digest.yesterday.errorRatePct).toBe(50);
    // Linear interpolation between [100, 500] at p95 → 100 + 0.95*400 = 480.
    expect(digest.yesterday.chatP95Ms).toBe(480);
    expect(digest.dayBefore.totalEvents).toBe(1);
    expect(digest.dayBefore.errorRatePct).toBe(0);
  });

  it('formats the digest as markdown carrying yesterday and prior values', async () => {
    await markActive('u1', 'org-a', YESTERDAY_KEY);
    const { intent } = await runDailyDigest(env.DB, NOW);
    expect(intent.kind).toBe('digest');
    expect(intent.markdown).toContain('Daily digest — 2026-05-11');
    expect(intent.markdown).toContain('Distinct users: **1**');
    expect(intent.markdown).toContain('_(prev 0)_');
  });
});
