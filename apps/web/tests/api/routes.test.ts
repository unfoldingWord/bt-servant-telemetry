import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, applyD1Migrations, SELF } from 'cloudflare:test';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    TELEMETRY_EPOCH: string;
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

describe('GET /api/health', () => {
  it('returns down when DB is empty', async () => {
    const res = await SELF.fetch('http://test/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; events_last_5m: number };
    expect(body.status).toBe('down');
    expect(body.events_last_5m).toBe(0);
  });

  it('returns up when fresh events exist', async () => {
    await env.DB.prepare(
      `INSERT INTO events (request_id, event, ts, level, org, user_hash, client_id)
       VALUES (?, ?, ?, NULL, 'unfoldingWord', ?, 'web')`
    )
      .bind('r1', 'request_received', Date.now() - 1000, 'a'.repeat(64))
      .run();
    const res = await SELF.fetch('http://test/api/health');
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('up');
  });
});

describe('GET /api/snapshot', () => {
  it('returns the full MetricsSnapshot shape', async () => {
    const res = await SELF.fetch('http://test/api/snapshot');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      distinct_users_all_time: expect.any(Number),
      distinct_users_30d: expect.any(Number),
      distinct_users_fixed_epoch: expect.any(Number),
      returning_users: expect.any(Number),
      login_count: expect.any(Number),
      error_rate_1h_pct: expect.any(Number),
      chat_busy_reject_rate_1h_pct: expect.any(Number),
      epoch_iso: '2026-04-24',
      generated_at_ts: expect.any(Number),
    });
    expect('chat_total_ms_p50' in body).toBe(true);
    expect('chat_total_ms_p95' in body).toBe(true);
  });
});

describe('GET /api/trend', () => {
  it('rejects missing metric param with 400', async () => {
    const res = await SELF.fetch('http://test/api/trend');
    expect(res.status).toBe(400);
  });

  it('rejects unknown metric with 400', async () => {
    const res = await SELF.fetch('http://test/api/trend?metric=banana');
    expect(res.status).toBe(400);
  });

  it('rejects out-of-range days with 400', async () => {
    const res = await SELF.fetch('http://test/api/trend?metric=distinct_users&days=999');
    expect(res.status).toBe(400);
  });

  it('rejects non-integer days with 400 (parseInt would silently accept these)', async () => {
    // Regression guard for the PR #3 review: parseInt("7foo") === 7 and
    // parseInt("7.5") === 7, which would silently violate the documented
    // "integer 1..90" contract. Strict regex check rejects both.
    for (const bad of ['7foo', '7.5', '-7', '', '0x7']) {
      const res = await SELF.fetch(
        `http://test/api/trend?metric=distinct_users&days=${encodeURIComponent(bad)}`
      );
      expect(res.status).toBe(400);
    }
  });

  it('returns TrendSeries with default days=30', async () => {
    const res = await SELF.fetch('http://test/api/trend?metric=distinct_users');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      metric: string;
      days: number;
      points: Array<{ day: number; value: number | null }>;
    };
    expect(body.metric).toBe('distinct_users');
    expect(body.days).toBe(30);
    expect(body.points.length).toBe(30);
  });

  it('accepts custom days param', async () => {
    const res = await SELF.fetch('http://test/api/trend?metric=error_rate&days=7');
    const body = (await res.json()) as { points: unknown[] };
    expect(body.points.length).toBe(7);
  });
});
