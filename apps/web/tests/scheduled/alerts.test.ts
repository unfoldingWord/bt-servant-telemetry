import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runAlertSweep } from '../../src/scheduled/index.js';

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
  await env.DB.exec('DELETE FROM posted_alerts');
});

const NOW = Date.UTC(2026, 4, 12, 12, 0, 0);
const ONE_MIN_MS = 60 * 1000;

async function insertEvent(row: {
  request_id: string;
  event: string;
  ts: number;
  level?: string | null;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO events (request_id, event, ts, level, org)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(row.request_id, row.event, row.ts, row.level ?? null, 'org-a')
    .run();
}

async function postedAlertKinds(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT alert_kind FROM posted_alerts ORDER BY alert_kind`
  ).all<{ alert_kind: string }>();
  return results.map((r) => r.alert_kind);
}

describe('runAlertSweep', () => {
  it('fires worker_offline when there are no events in the last 5 min and inserts dedupe row', async () => {
    const { intents, conditions } = await runAlertSweep(env.DB, NOW);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ kind: 'alert', alertKind: 'worker_offline' });
    expect(conditions.find((c) => c.kind === 'worker_offline')?.firing).toBe(true);
    expect(conditions.find((c) => c.kind === 'error_rate_high')?.firing).toBe(false);
    expect(await postedAlertKinds()).toEqual(['worker_offline']);
  });

  it('does not re-fire worker_offline on the next sweep while the row is present', async () => {
    await runAlertSweep(env.DB, NOW);
    const { intents } = await runAlertSweep(env.DB, NOW + ONE_MIN_MS);
    expect(intents).toEqual([]);
    expect(await postedAlertKinds()).toEqual(['worker_offline']);
  });

  it('clears the worker_offline dedupe row when events return', async () => {
    await runAlertSweep(env.DB, NOW); // first fire
    await insertEvent({ request_id: 'r1', event: 'request_received', ts: NOW + ONE_MIN_MS });
    const { intents } = await runAlertSweep(env.DB, NOW + 2 * ONE_MIN_MS);
    expect(intents).toEqual([]);
    expect(await postedAlertKinds()).toEqual([]);
  });

  it('fires error_rate_high when >2% of events in the 10min window are errors', async () => {
    // 1 healthy + 1 error in last 5 min (so worker_offline does NOT fire),
    // plus 8 healthy older events to get rate = 1/10 = 10% > 2%.
    for (let i = 0; i < 8; i++) {
      await insertEvent({
        request_id: `o${i}`,
        event: 'request_received',
        ts: NOW - 8 * ONE_MIN_MS + i * 1000,
      });
    }
    await insertEvent({ request_id: 'r1', event: 'request_received', ts: NOW - ONE_MIN_MS });
    await insertEvent({
      request_id: 'r2',
      event: 'mcp_tool_call_error',
      ts: NOW - ONE_MIN_MS + 500,
      level: 'error',
    });
    const { intents, conditions } = await runAlertSweep(env.DB, NOW);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ kind: 'alert', alertKind: 'error_rate_high' });
    expect(conditions.find((c) => c.kind === 'worker_offline')?.firing).toBe(false);
    expect(await postedAlertKinds()).toEqual(['error_rate_high']);
  });

  it('does not fire error_rate_high while the rate stays exactly at threshold (2%)', async () => {
    // 49 healthy + 1 error = 2% exactly — must NOT fire (strict >).
    for (let i = 0; i < 49; i++) {
      await insertEvent({
        request_id: `h${i}`,
        event: 'request_received',
        ts: NOW - 8 * ONE_MIN_MS + i,
      });
    }
    await insertEvent({
      request_id: 'e1',
      event: 'mcp_tool_call_error',
      ts: NOW - ONE_MIN_MS,
      level: 'error',
    });
    const { intents, conditions } = await runAlertSweep(env.DB, NOW);
    expect(conditions.find((c) => c.kind === 'error_rate_high')?.firing).toBe(false);
    expect(intents).toEqual([]);
  });

  it('suppresses error_rate_high when worker_offline is also firing', async () => {
    // No events in last 5 min, but errors in the 6-10 min window.
    await insertEvent({
      request_id: 'old1',
      event: 'mcp_tool_call_error',
      ts: NOW - 7 * ONE_MIN_MS,
      level: 'error',
    });
    await insertEvent({
      request_id: 'old2',
      event: 'request_received',
      ts: NOW - 8 * ONE_MIN_MS,
    });
    const { intents, conditions } = await runAlertSweep(env.DB, NOW);
    expect(conditions.find((c) => c.kind === 'worker_offline')?.firing).toBe(true);
    expect(conditions.find((c) => c.kind === 'error_rate_high')?.firing).toBe(false);
    expect(intents.map((i) => (i.kind === 'alert' ? i.alertKind : null))).toEqual([
      'worker_offline',
    ]);
  });
});
