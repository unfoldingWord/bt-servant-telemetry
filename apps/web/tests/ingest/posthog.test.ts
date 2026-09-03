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
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  env,
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { tailHandler } from '../../src/tail/index.js';
import { toGenerationProperties } from '../../src/ingest/posthog.js';
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
const withPostHog = { ...env, POSTHOG_API_KEY: 'phc_test_key', POSTHOG_HOST: PH_HOST };

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

async function runTail(e: typeof withPostHog | typeof env): Promise<void> {
  const ctx = createExecutionContext();
  await tailHandler(buildTraceItems(), e, ctx);
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

describe('tail handler -> PostHog', () => {
  it('emits exactly one $ai_generation for the one chat_turn, keyed by user_hash and turn_id', async () => {
    const seen = stubPostHogFetch();
    await runTail(withPostHog);

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
    await runTail(env);
    expect(seen).toHaveLength(0);
  });

  it('still ingests to D1 when PostHog is unreachable', async () => {
    // posthog-node reports transport failures through its own logger
    // (console.error) after exhausting retries; our own warn covers a
    // rejected shutdown. Either way the failure must be visible, not silent.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubPostHogFetch(503);
    await runTail(withPostHog);

    const row = await env.DB.prepare(`SELECT turn_id FROM events WHERE event = 'chat_turn'`).first<{
      turn_id: string;
    }>();
    expect(row?.turn_id).toBe('7ca7aedd-cc08-494d-9102-a1277a0f2775');
    // and the failure was observable, not swallowed
    const msgs = [...warn.mock.calls, ...err.mock.calls].map((c) => c.map(String).join(' '));
    expect(msgs.some((m) => /posthog/i.test(m))).toBe(true);
  });
});
