/**
 * PostHog emitter — the only path by which BT Servant data reaches PostHog.
 *
 * Runs the REAL posthog-node client against a stubbed `fetch`, so the wiring
 * (client options, event shape, flush-on-shutdown) is exercised end to end
 * without network. Three properties matter enough to pin here:
 *   1. Exactly one `$ai_generation` per chat_turn, carrying PostHog's required
 *      fields, with `$ai_latency` in SECONDS.
 *   2. No key => no client, no fetch. Deploys are safe before secrets land.
 *   3. PostHog failing must never break D1 ingest — the durable record.
 *   4. What PostHog receives is the SETTLED session: turns wait in D1 for the
 *      settle window, so concurrent or late siblings re-stitch them first,
 *      and only the once-a-minute cron sends them.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  env,
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { tailHandler } from '../../src/tail/index.js';
import {
  CRON_POSTHOG_FLUSH,
  scheduledHandler,
  type ScheduledEnv,
} from '../../src/scheduled/index.js';
import {
  flushQueuedTurns,
  toGenerationProperties,
  type PostHogEnv,
} from '../../src/ingest/posthog.js';
import { redact } from '../../src/ingest/redact.js';
import { buildTraceItems, sampleLogMessages } from '../fixtures/sample-tail-events.js';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    PII_HASH_SALT: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}

const PH_HOST = 'https://ph.test';
/** Settle of 0: a turn is eligible for the very next tick after ingest. */
const withPostHog = {
  ...env,
  POSTHOG_API_KEY: 'phc_test_key',
  POSTHOG_HOST: PH_HOST,
  POSTHOG_SETTLE_SECONDS: '0',
};
/** The production-shaped configuration: turns wait a minute before sending. */
const withSettle = { ...withPostHog, POSTHOG_SETTLE_SECONDS: '60' };

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);
const MIN = 60_000;
const CHAT_TURN = sampleLogMessages.find((m) => m.includes('"event":"chat_turn"')) as string;

/**
 * A readable name as a UUID. posthog-node silently replaces a non-UUID event
 * `uuid` with one of its own, which would defeat the idempotency assertions.
 */
function U(name: string): string {
  const hex = [...name].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  return `00000000-0000-4000-8000-${hex.padStart(12, '0')}`;
}

/** A raw chat_turn log line like the fixture's, with its own ids and timestamp. */
function turnMessage(name: string, ts: number): string {
  const o = JSON.parse(CHAT_TURN) as Record<string, unknown>;
  Object.assign(o, { turn_id: U(name), request_id: `req-${name}`, timestamp: ts });
  return JSON.stringify(o);
}

async function runTailAt(e: typeof withPostHog, messages: string[], nowMs: number): Promise<void> {
  const ctx = createExecutionContext();
  await tailHandler(buildTraceItems(messages), e, ctx, { nowMs });
  await waitOnExecutionContext(ctx);
}

function sessionOf(g: Record<string, unknown>): { id: unknown; index: unknown } {
  const p = g.properties as Record<string, unknown>;
  return { id: p.$ai_session_id, index: p.session_turn_index };
}

type Captured = { url: string; body: Record<string, unknown> };

/**
 * posthog-node's edge build posts the batch as a Blob (and may gzip it), so
 * `String(init.body)` is "[object Blob]". Decode it the way a server would.
 */
async function decodeBody(init: RequestInit | undefined): Promise<Record<string, unknown>> {
  const headers = new Headers(init?.headers);
  let stream: ReadableStream<Uint8Array> | null = new Response(init?.body as BodyInit).body;
  if (stream && headers.get('content-encoding') === 'gzip') {
    stream = stream.pipeThrough(new DecompressionStream('gzip'));
  }
  const text = stream ? await new Response(stream).text() : '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

/** Intercept only PostHog traffic; everything else (D1 is a binding, not fetch) is untouched. */
function stubPostHogFetch(status = 200): Captured[] {
  const seen: Captured[] = [];
  const real = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith(PH_HOST)) return real(input, init);
    if (status >= 500) throw new Error('posthog unreachable');
    seen.push({ url, body: await decodeBody(init) });
    return new Response('{"status":1}', {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return seen;
}

function generationsFrom(seen: Captured[]): Array<Record<string, unknown>> {
  return seen.flatMap((c) => {
    const batch = (c.body.batch as Array<Record<string, unknown>> | undefined) ?? [c.body];
    return batch.filter((e) => e.event === '$ai_generation');
  });
}

/** Ingest the fixture batch, then run the cron tick that sends to PostHog. */
async function runTailThenTick(e: typeof withPostHog | typeof env): Promise<void> {
  const ctx = createExecutionContext();
  await tailHandler(buildTraceItems(), e, ctx);
  await waitOnExecutionContext(ctx);
  await flushQueuedTurns(env.DB, e as PostHogEnv, Date.now());
}

/** The real dispatcher path: the once-a-minute cron and nothing else. */
async function cronTick(e: typeof withPostHog, nowMs: number): Promise<void> {
  const ctx = createExecutionContext();
  await scheduledHandler(
    { cron: CRON_POSTHOG_FLUSH, scheduledTime: nowMs, noRetry: () => undefined },
    e as unknown as ScheduledEnv,
    ctx,
    { sink: vi.fn(), nowMs }
  );
  await waitOnExecutionContext(ctx);
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await env.DB.exec('DELETE FROM events');
  await env.DB.exec('DELETE FROM users');
  await env.DB.exec('DELETE FROM user_active_days');
});
afterEach(() => vi.restoreAllMocks());

describe('mapping a turn to $ai_generation', () => {
  it('carries every field PostHog requires, with latency in seconds', async () => {
    const raw = sampleLogMessages.find((m) => m.includes('"event":"chat_turn"')) as string;
    const evt = await redact(raw, 'salt');
    expect(evt).not.toBeNull();
    const p = toGenerationProperties(evt as NonNullable<typeof evt>);

    expect(p.$ai_trace_id).toBe('7ca7aedd-cc08-494d-9102-a1277a0f2775');
    expect(p.$ai_model).toBe('claude-sonnet-4-6');
    expect(p.$ai_provider).toBe('anthropic');
    expect(p.$ai_input_tokens).toBe(3);
    expect(p.$ai_output_tokens).toBe(18);
    expect(p.$ai_cache_creation_input_tokens).toBe(3507);
    // 1726 ms -> 1.726 s. PostHog's unit is seconds; this is the trap.
    expect(p.$ai_latency).toBeCloseTo(1.726, 6);
    expect(p.mode).toBe('local-test');
    expect(p.$set).toEqual({ org: 'unfoldingWord', client_id: 'whatsapp' });
  });

  it('never includes message text and drops null fields', async () => {
    const raw = sampleLogMessages.find((m) => m.includes('"event":"chat_turn"')) as string;
    const evt = await redact(raw, 'salt');
    const p = toGenerationProperties(evt as NonNullable<typeof evt>);
    expect(p).not.toHaveProperty('$ai_input');
    expect(p).not.toHaveProperty('$ai_output_choices');
    // language was null on the wire -> absent, not null
    expect(p).not.toHaveProperty('language');
    expect(Object.values(p).some((v) => v === null)).toBe(false);
  });
});

describe('tail ingest -> cron tick -> PostHog', () => {
  it('emits exactly one $ai_generation for the one chat_turn, keyed by user_hash and turn_id', async () => {
    const seen = stubPostHogFetch();
    await runTailThenTick(withPostHog);

    const gens = generationsFrom(seen);
    expect(gens).toHaveLength(1);
    const [g] = gens as [Record<string, unknown>];
    expect(g.distinct_id).toMatch(/^[0-9a-f]{64}$/);
    expect(g.uuid).toBe('7ca7aedd-cc08-494d-9102-a1277a0f2775');
    expect((g.properties as Record<string, unknown>).$ai_trace_id).toBe(
      '7ca7aedd-cc08-494d-9102-a1277a0f2775'
    );
    // dev and production share one PostHog project; this is what keeps them apart
    expect((g.properties as Record<string, unknown>).environment).toBe('test');
    // a lone turn is a session of one, named after itself
    expect((g.properties as Record<string, unknown>).$ai_session_id).toBe(
      '7ca7aedd-cc08-494d-9102-a1277a0f2775'
    );
    expect((g.properties as Record<string, unknown>).session_turn_index).toBe(1);
    // raw phone number must never appear anywhere in what left the process
    expect(JSON.stringify(seen)).not.toContain('15551234567');
  });

  it('sends nothing at all when POSTHOG_API_KEY is unset', async () => {
    const seen = stubPostHogFetch();
    await runTailThenTick(env);
    expect(seen).toHaveLength(0);
  });

  it('keeps a turn unsent when PostHog is unreachable, and sends it on a later tick', async () => {
    // posthog-node reports transport failures through its own logger
    // (console.error) after exhausting retries; our own warn covers the
    // failed batch. Either way the failure must be visible, not silent.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubPostHogFetch(503);
    await runTailThenTick(withPostHog);

    const row = await env.DB.prepare(
      `SELECT turn_id, posthog_emitted_at FROM events WHERE event = 'chat_turn'`
    ).first<{ turn_id: string; posthog_emitted_at: number | null }>();
    expect(row?.turn_id).toBe('7ca7aedd-cc08-494d-9102-a1277a0f2775'); // D1 ingest unaffected
    expect(row?.posthog_emitted_at).toBeNull(); // not marked: still owed to PostHog
    const msgs = [...warn.mock.calls, ...err.mock.calls].map((c) => c.map(String).join(' '));
    expect(msgs.some((m) => /posthog/i.test(m))).toBe(true);

    // PostHog comes back: the next tick sends exactly that turn.
    vi.restoreAllMocks();
    const seen = stubPostHogFetch();
    expect(await flushQueuedTurns(env.DB, withPostHog, Date.now())).toBe(1);
    expect(generationsFrom(seen).map((g) => g.uuid)).toEqual([
      '7ca7aedd-cc08-494d-9102-a1277a0f2775',
    ]);
  });
});

describe('settled delivery', () => {
  it('holds a turn for the settle window, then the cron sends it with its D1 session', async () => {
    const seen = stubPostHogFetch();
    await runTailAt(withSettle, [turnMessage('a', NOW - 5 * MIN)], NOW);
    await cronTick(withSettle, NOW + 30_000);
    expect(generationsFrom(seen)).toHaveLength(0); // queued, not yet settled

    await cronTick(withSettle, NOW + 61_000);
    const gens = generationsFrom(seen);
    expect(gens.map((g) => g.uuid)).toEqual([U('a')]);
    expect(sessionOf(gens[0] as Record<string, unknown>)).toEqual({ id: U('a'), index: 1 });
  });

  it('does not send from the tail handler itself', async () => {
    const seen = stubPostHogFetch();
    await runTailAt(withPostHog, [turnMessage('a', NOW - 5 * MIN)], NOW); // settle 0
    expect(seen).toHaveLength(0);
  });

  it('marks a turn emitted only after PostHog accepts it, then never resends', async () => {
    const seen = stubPostHogFetch();
    await runTailAt(withSettle, [turnMessage('a', NOW)], NOW);
    const emittedAt = async (): Promise<number | null> =>
      (
        await env.DB.prepare(
          `SELECT posthog_emitted_at FROM events WHERE event = 'chat_turn'`
        ).first<{
          posthog_emitted_at: number | null;
        }>()
      )?.posthog_emitted_at ?? null;
    expect(await emittedAt()).toBeNull();

    await cronTick(withSettle, NOW + 61_000);
    expect(await emittedAt()).toBe(NOW + 61_000);

    await cronTick(withSettle, NOW + 10 * MIN); // emitted is final
    expect(generationsFrom(seen).map((g) => g.uuid)).toEqual([U('a')]);
  });

  it('sends the converged session when concurrent invocations arrive in reverse order', async () => {
    const seen = stubPostHogFetch();
    await runTailAt(withSettle, [turnMessage('a', NOW - 10 * MIN)], NOW - 10 * MIN);
    // Six one-turn invocations racing for the same user, newest first: each
    // insert re-stitches the ones already stored, so no single invocation's
    // own view of its turn can be trusted.
    // tN is the Nth turn in time (t1 at -6m ... t6 at -1m); they ARRIVE t6 first.
    const names = ['t6', 't5', 't4', 't3', 't2', 't1'];
    const tsOf = (n: string): number => NOW - (7 - Number(n.slice(1))) * MIN;
    await Promise.all(names.map((n) => runTailAt(withSettle, [turnMessage(n, tsOf(n))], NOW)));

    await cronTick(withSettle, NOW + 61_000);
    const gens = generationsFrom(seen).map((g) => ({ uuid: g.uuid, ...sessionOf(g) }));
    expect(gens.map((g) => g.id)).toEqual(Array(7).fill(U('a')));
    const indexByName = Object.fromEntries(
      ['a', ...names].map((n) => [n, gens.find((g) => g.uuid === U(n))?.index])
    );
    expect(indexByName).toEqual({ a: 1, t1: 2, t2: 3, t3: 4, t4: 5, t5: 6, t6: 7 });
  });
});
