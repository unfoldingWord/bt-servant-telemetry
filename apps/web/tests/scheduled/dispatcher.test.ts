import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CRON_ALERT_SWEEP,
  CRON_DIGEST,
  CRON_MILESTONE_WATCH,
  CRON_RECONCILE,
  scheduledHandler,
  type PostIntent,
} from '../../src/scheduled/index.js';

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
  await env.DB.exec('DELETE FROM user_active_days');
  await env.DB.exec('DELETE FROM posted_alerts');
  await env.DB.exec('DELETE FROM reached_milestones');
});

const NOW = Date.UTC(2026, 4, 12, 12, 0, 0);

function makeController(cron: string): ScheduledController {
  return { cron, scheduledTime: NOW, noRetry: () => undefined } as ScheduledController;
}

const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

const scheduledEnv = {
  ...env,
  CF_API_TOKEN: 'token',
  CF_ACCOUNT_ID: 'account',
  SOURCE_WORKER_NAME: 'bt-servant-worker',
};

describe('scheduledHandler dispatcher', () => {
  it('routes the alert-sweep cron to the alert sweeper and forwards intents to the sink', async () => {
    const intents: PostIntent[] = [];
    const sink = vi.fn(async (i: PostIntent) => {
      intents.push(i);
    });
    await scheduledHandler(makeController(CRON_ALERT_SWEEP), scheduledEnv, ctx, {
      sink,
      nowMs: NOW,
    });
    // Empty DB → worker_offline fires.
    expect(intents.map((i) => (i.kind === 'alert' ? i.alertKind : i.kind))).toEqual([
      'worker_offline',
    ]);
  });

  it('routes the digest cron to runDailyDigest', async () => {
    const intents: PostIntent[] = [];
    const sink = vi.fn(async (i: PostIntent) => {
      intents.push(i);
    });
    await scheduledHandler(makeController(CRON_DIGEST), scheduledEnv, ctx, { sink, nowMs: NOW });
    expect(intents).toHaveLength(1);
    expect(intents[0]?.kind).toBe('digest');
  });

  it('routes the milestone cron to runMilestoneWatch (no intent when count below threshold)', async () => {
    const sink = vi.fn(async () => undefined);
    await scheduledHandler(makeController(CRON_MILESTONE_WATCH), scheduledEnv, ctx, {
      sink,
      nowMs: NOW,
    });
    expect(sink).not.toHaveBeenCalled();
  });

  it('routes the reconcile cron through runBackfill (mocked fetch returning empty)', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ result: { events: { events: [] } } })));
    const intents: PostIntent[] = [];
    const sink = vi.fn(async (i: PostIntent) => {
      intents.push(i);
    });
    await scheduledHandler(makeController(CRON_RECONCILE), scheduledEnv, ctx, {
      sink,
      fetchImpl: fetchMock,
      nowMs: NOW,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(intents).toHaveLength(1);
    expect(intents[0]?.kind).toBe('reconcile');
  });

  it('throws on an unknown cron pattern (config drift between wrangler.toml and code)', async () => {
    await expect(
      scheduledHandler(makeController('99 99 99 99 99'), scheduledEnv, ctx, {
        sink: vi.fn(),
        nowMs: NOW,
      })
    ).rejects.toThrow(/no handler for cron pattern/);
  });
});
