import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, applyD1Migrations, createExecutionContext } from 'cloudflare:test';
import { tailHandler } from '../../src/tail/index.js';
import { buildTraceItems } from '../fixtures/sample-tail-events.js';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    PII_HASH_SALT: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM events');
  await env.DB.exec('DELETE FROM users');
});

describe('tail handler ingests bt-servant-worker logs end-to-end', () => {
  it('upserts events into D1 with hashed user identifiers', async () => {
    await tailHandler(buildTraceItems(), env, createExecutionContext());

    const { results: events } = await env.DB.prepare(
      'SELECT request_id, event, level, user_hash, total_ms FROM events ORDER BY ts'
    ).all<{
      request_id: string;
      event: string;
      level: string | null;
      user_hash: string | null;
      total_ms: number | null;
    }>();

    expect(events.length).toBeGreaterThanOrEqual(11);
    const errorEvents = events.filter((e) => e.level === 'error');
    expect(errorEvents.length).toBe(3);
    const completes = events.filter((e) => e.event === 'process_chat_complete');
    expect(completes.length).toBe(3);
    expect(completes.every((e) => typeof e.total_ms === 'number')).toBe(true);
  });

  it('upserts unique users keyed by (user_hash, org)', async () => {
    await tailHandler(buildTraceItems(), env, createExecutionContext());

    const { results: users } = await env.DB.prepare(
      'SELECT user_hash, org, client_id, days_active_count FROM users'
    ).all<{
      user_hash: string;
      org: string;
      client_id: string;
      days_active_count: number;
    }>();

    expect(users.length).toBe(2);
    const clientIds = new Set(users.map((u) => u.client_id));
    expect(clientIds).toEqual(new Set(['web', 'whatsapp']));
    expect(users.every((u) => /^[0-9a-f]{64}$/.test(u.user_hash))).toBe(true);
  });

  it('PII audit: no D1 row contains a raw phone, email, response, or stack', async () => {
    await tailHandler(buildTraceItems(), env, createExecutionContext());

    const eventsDump = await env.DB.prepare('SELECT * FROM events').all();
    const usersDump = await env.DB.prepare('SELECT * FROM users').all();
    const blob = JSON.stringify(eventsDump.results) + JSON.stringify(usersDump.results);

    expect(blob).not.toMatch(/15551234567/);
    expect(blob).not.toMatch(/test-user@example\.com/);
    expect(blob).not.toMatch(/REDACTED_RESPONSE/);
    expect(blob).not.toMatch(/parseJsonRpcResponse/);
    expect(blob).not.toMatch(/@/);
  });

  it('is idempotent - replaying the same batch leaves row counts unchanged', async () => {
    await tailHandler(buildTraceItems(), env, createExecutionContext());
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>();

    await tailHandler(buildTraceItems(), env, createExecutionContext());
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>();

    expect(after?.n).toBe(before?.n);
  });

  it('handles empty input gracefully', async () => {
    await tailHandler([], env, createExecutionContext());
    const events = await env.DB.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>();
    expect(events?.n).toBe(0);
  });
});
