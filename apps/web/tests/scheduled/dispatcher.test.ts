import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CRON_ALERT_SWEEP,
  CRON_DIGEST,
  CRON_MILESTONE_WATCH,
  CRON_POSTHOG_FLUSH,
  CRON_RECONCILE,
  jobForCron,
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

  it('routes the PostHog flush cron and posts nothing', async () => {
    const sink = vi.fn();
    // No POSTHOG_API_KEY in the test env: the tick is a no-op that touches nothing.
    await scheduledHandler(makeController(CRON_POSTHOG_FLUSH), scheduledEnv, ctx, {
      sink,
      nowMs: NOW,
    });
    expect(sink).not.toHaveBeenCalled();
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

/**
 * The heartbeat (issue #42). Silence used to be compatible with "cron never
 * fired", "no API key", "queue empty" and "sent fine" all at once; one line per
 * invocation makes those four states tellable apart from a `wrangler tail`.
 */
describe('cron_tick heartbeat', () => {
  function captureTicks(): { ticks: () => Record<string, unknown>[] } {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ticks = (): Record<string, unknown>[] =>
      [...log.mock.calls, ...err.mock.calls]
        .map((c) => c[0])
        .filter((line): line is string => typeof line === 'string' && line.startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((o) => o.event === 'cron_tick');
    return { ticks };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const fetchMock = (): ReturnType<typeof vi.fn<typeof fetch>> =>
    vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ result: { events: { events: [] } } })));

  it.each([
    [CRON_RECONCILE, 'reconcile'],
    [CRON_DIGEST, 'digest'],
    [CRON_ALERT_SWEEP, 'alert_sweep'],
    [CRON_POSTHOG_FLUSH, 'posthog_flush'],
    [CRON_MILESTONE_WATCH, 'milestone_watch'],
  ])('emits exactly one tick for %s naming job %s', async (cron, job) => {
    const { ticks } = captureTicks();
    await scheduledHandler(makeController(cron), scheduledEnv, ctx, {
      sink: vi.fn(),
      fetchImpl: fetchMock(),
      nowMs: NOW,
    });
    const seen = ticks();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ event: 'cron_tick', level: 'info', ok: true, cron, job });
    expect(typeof seen[0]?.ms).toBe('number');
  });

  it('distinguishes the quiet PostHog exits: no key, nothing eligible, nothing sent', async () => {
    const { ticks } = captureTicks();
    // The test env has no POSTHOG_API_KEY: the queue-and-wait state.
    await scheduledHandler(makeController(CRON_POSTHOG_FLUSH), scheduledEnv, ctx, {
      sink: vi.fn(),
      nowMs: NOW,
    });
    expect(ticks()[0]).toMatchObject({
      job: 'posthog_flush',
      hasKey: false,
      eligible: 0,
      sent: 0,
      sweptText: 0,
      posted: 0,
    });
  });

  it('reports the user count on an idle milestone tick that crosses nothing', async () => {
    const { ticks } = captureTicks();
    await scheduledHandler(makeController(CRON_MILESTONE_WATCH), scheduledEnv, ctx, {
      sink: vi.fn(),
      nowMs: NOW,
    });
    expect(ticks()[0]).toMatchObject({ job: 'milestone_watch', users: 0, crossed: 0, posted: 0 });
  });

  it('names the firing conditions on an alert sweep', async () => {
    const { ticks } = captureTicks();
    await scheduledHandler(makeController(CRON_ALERT_SWEEP), scheduledEnv, ctx, {
      sink: vi.fn(),
      nowMs: NOW,
    });
    // Empty DB → worker_offline fires and is posted for the first time.
    expect(ticks()[0]).toMatchObject({
      job: 'alert_sweep',
      firing: ['worker_offline'],
      posted: 1,
    });
  });

  it('logs a failing tick at error level and still rethrows', async () => {
    const { ticks } = captureTicks();
    const boom = new Error('sink is down');
    await expect(
      scheduledHandler(makeController(CRON_ALERT_SWEEP), scheduledEnv, ctx, {
        sink: vi.fn().mockRejectedValue(boom),
        nowMs: NOW,
      })
    ).rejects.toThrow('sink is down');
    expect(ticks()).toEqual([
      expect.objectContaining({
        event: 'cron_tick',
        level: 'error',
        ok: false,
        cron: CRON_ALERT_SWEEP,
        job: 'alert_sweep',
        error: 'sink is down',
      }),
    ]);
  });

  // The job name is resolved before dispatch precisely so it survives a job
  // that dies before returning anything. Without it, filtering by
  // `job = "reconcile"` would return no heartbeat for the failed invocation —
  // indistinguishable from the cron never having fired, which is the whole
  // ambiguity this change removes.
  it('names the job even when dispatch itself throws before returning a result', async () => {
    const { ticks } = captureTicks();
    await expect(
      scheduledHandler(makeController(CRON_RECONCILE), scheduledEnv, ctx, {
        sink: vi.fn(),
        fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error('upstream down')),
        nowMs: NOW,
      })
    ).rejects.toThrow();
    expect(ticks()[0]).toMatchObject({ level: 'error', ok: false, job: 'reconcile' });
  });

  it('falls back to job "unknown" on a cron pattern with no handler', async () => {
    const { ticks } = captureTicks();
    await expect(
      scheduledHandler(makeController('99 99 99 99 99'), scheduledEnv, ctx, {
        sink: vi.fn(),
        nowMs: NOW,
      })
    ).rejects.toThrow(/no handler for cron pattern/);
    expect(ticks()[0]).toMatchObject({ level: 'error', ok: false, job: 'unknown' });
  });

  it('has a job name for every cron the dispatcher handles', () => {
    // Guards the one drift this design allows: a cron added to dispatch's
    // if-chain but not to JOB_BY_CRON would log job "unknown" on success.
    for (const cron of [
      CRON_RECONCILE,
      CRON_DIGEST,
      CRON_ALERT_SWEEP,
      CRON_POSTHOG_FLUSH,
      CRON_MILESTONE_WATCH,
    ]) {
      expect(jobForCron(cron)).not.toBe('unknown');
    }
  });
});
