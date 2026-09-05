/**
 * PostHog emitter — the only path by which BT Servant data reaches PostHog.
 *
 * Runs the REAL posthog-node client against a stubbed `fetch`, so the wiring
 * (client options, event shape, flush-on-shutdown) is exercised end to end
 * without network. Six properties matter enough to pin here:
 *   1. Exactly one `$ai_generation` per chat_turn, carrying PostHog's required
 *      fields, with `$ai_latency` in SECONDS.
 *   2. No key => no client, no fetch. Deploys are safe before secrets land.
 *   3. PostHog failing must never break D1 ingest — the durable record.
 *   4. What PostHog receives is the SETTLED session: turns wait in D1 for the
 *      settle window, so concurrent or late siblings re-stitch them first,
 *      and only the once-a-minute cron sends them.
 *   5. Conversation text reaches PostHog only scrubbed, only when a scrubber
 *      key exists, and never lingers in D1 once sent.
 *   6. Tool calls arrive twice from one list — as `tool_use` blocks on the
 *      generation and as one `$ai_span` each — with ids derived from the turn,
 *      so a resend is idempotent and arguments never travel.
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
import { toolCallUuid } from '../../src/ingest/tool-calls.js';
import { buildTraceItems, sampleLogMessages } from '../fixtures/sample-tail-events.js';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    PII_HASH_SALT: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}

type R = Record<string, unknown>;

const PH_HOST = 'https://ph.test';
const ANTHROPIC_HOST = 'https://api.anthropic.com';
/** Settle of 0: a turn is eligible for the very next tick after ingest. */
const withPostHog = {
  ...env,
  POSTHOG_API_KEY: 'phc_test_key',
  POSTHOG_HOST: PH_HOST,
  POSTHOG_SETTLE_SECONDS: '0',
};
/** The production-shaped configuration: turns wait a minute before sending. */
const withSettle = { ...withPostHog, POSTHOG_SETTLE_SECONDS: '60' };
/** PostHog plus a scrubber key: the only configuration under which text may flow. */
const withText = { ...withPostHog, ANTHROPIC_API_KEY: 'sk-ant-test' };

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

const USER_TEXT = 'My pastor Bob said to call him at +1 (555) 010-9999. What does John 3:16 mean?';
const REPLY_TEXT = "Bob may be thinking of John 3:16, where Jesus speaks of God's love.";

/** A chat_turn line carrying conversation text, as the engine now emits it. */
function textTurn(name: string, ts: number): string {
  const o = JSON.parse(turnMessage(name, ts)) as Record<string, unknown>;
  Object.assign(o, { user_message: USER_TEXT, assistant_reply: REPLY_TEXT });
  return JSON.stringify(o);
}

/** Two tool calls as the engine records them: a lookup that worked, then one that failed. */
const TOOL_CALLS = (ts: number): Array<Record<string, unknown>> => [
  {
    name: 'fetch_scripture',
    server_id: 'translation-helps',
    started_at: ts - 3000,
    duration_ms: 812,
    ok: true,
  },
  {
    name: 'search_translation_notes',
    server_id: 'translation-helps',
    started_at: ts - 2000,
    duration_ms: 1500,
    ok: false,
  },
];

/** A chat_turn line carrying tool calls and the engine build, on top of `base`. */
function toolTurn(base: string, ts: number, extra: Record<string, unknown> = {}): string {
  const o = JSON.parse(base) as Record<string, unknown>;
  Object.assign(o, { engine_version: '2.49.0', tool_calls: TOOL_CALLS(ts), ...extra });
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

/**
 * Stand-in for the scrubbing model: swaps "Bob" for [name] in each tagged
 * section and answers in the structured-output shape the SDK parses. In
 * 'fail' mode it answers 400, which the SDK does not retry.
 */
let anthropicMode: 'ok' | 'fail' = 'ok';
function fakeScrubber(init: RequestInit | undefined): Response {
  const headers = { 'content-type': 'application/json' };
  if (anthropicMode === 'fail') {
    const error = { type: 'error', error: { type: 'invalid_request_error', message: 'nope' } };
    return new Response(JSON.stringify(error), { status: 400, headers });
  }
  const req = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
  const prompt = req.messages[0]?.content ?? '';
  const pick = (tag: string): string =>
    new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(prompt)?.[1] ?? '';
  const scrub = (s: string): string => s.replace(/Bob/g, '[name]');
  const text = JSON.stringify({
    user_message: scrub(pick('user_message')),
    assistant_reply: scrub(pick('assistant_reply')),
  });
  const message = {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  return new Response(JSON.stringify(message), { status: 200, headers });
}

/** Intercept PostHog and Anthropic traffic; everything else (D1 is a binding, not fetch) is untouched. */
function stubPostHogFetch(status = 200): Captured[] {
  const seen: Captured[] = [];
  const real = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(ANTHROPIC_HOST)) return fakeScrubber(init);
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

function eventsFrom(seen: Captured[], name: string): Array<Record<string, unknown>> {
  return seen.flatMap((c) => {
    const batch = (c.body.batch as Array<Record<string, unknown>> | undefined) ?? [c.body];
    return batch.filter((e) => e.event === name);
  });
}

function generationsFrom(seen: Captured[]): Array<Record<string, unknown>> {
  return eventsFrom(seen, '$ai_generation');
}

function spansFrom(seen: Captured[]): Array<Record<string, unknown>> {
  return eventsFrom(seen, '$ai_span');
}

/** The properties of the first generation PostHog received. */
function propsOf(seen: Captured[]): Record<string, unknown> {
  const [g] = generationsFrom(seen) as [Record<string, unknown>];
  return g.properties as Record<string, unknown>;
}

/** How many times the scrubber has been called through the stubbed fetch. */
function scrubCalls(): number {
  return (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) =>
    String(c[0]).startsWith(ANTHROPIC_HOST)
  ).length;
}

async function spooledCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT count(*) AS n FROM turn_text').first<{ n: number }>();
  return row?.n ?? -1;
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
  await env.DB.exec('DELETE FROM turn_text');
});
afterEach(() => {
  vi.restoreAllMocks();
  anthropicMode = 'ok';
});

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

  it('carries no text when the record has none, and drops null fields', async () => {
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

describe('conversation text', () => {
  it('sends the scrubbed conversation with the generation, then forgets the text', async () => {
    const seen = stubPostHogFetch();
    await runTailAt(withText, [textTurn('a', NOW - MIN)], NOW);

    // Spooled already scrubbed: neither the name nor the number exists anywhere in D1.
    expect(await spooledCount()).toBe(1);
    const spool = await env.DB.prepare('SELECT * FROM turn_text').all();
    const events = await env.DB.prepare('SELECT * FROM events').all();
    const d1 = JSON.stringify(spool.results) + JSON.stringify(events.results);
    expect(d1).not.toContain('Bob');
    expect(d1).not.toContain('010-9999');
    expect(d1).toContain('[name]');
    expect(d1).toContain('[phone]');

    await flushQueuedTurns(env.DB, withText, NOW);
    const p = propsOf(seen);
    expect(p.text_status).toBe('scrubbed');
    expect(p.$ai_input).toEqual([
      {
        role: 'user',
        content: 'My pastor [name] said to call him at [phone]. What does John 3:16 mean?',
      },
    ]);
    expect(p.$ai_output_choices).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: "[name] may be thinking of John 3:16, where Jesus speaks of God's love.",
          },
        ],
      },
    ]);
    expect(JSON.stringify(seen)).not.toContain('Bob');
    expect(JSON.stringify(seen)).not.toContain('010-9999');
    expect(await spooledCount()).toBe(0); // sent ⇒ forgotten
  });

  it('keeps the text spooled when PostHog rejects the batch, and sends it on the next tick', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubPostHogFetch(503);
    await runTailAt(withText, [textTurn('b', NOW - MIN)], NOW);
    expect(await flushQueuedTurns(env.DB, withText, NOW)).toBe(0);
    expect(await spooledCount()).toBe(1); // nothing sent, nothing forgotten

    vi.restoreAllMocks();
    const seen = stubPostHogFetch();
    expect(await flushQueuedTurns(env.DB, withText, NOW + MIN)).toBe(1);
    expect(propsOf(seen).text_status).toBe('scrubbed');
    expect(propsOf(seen)).toHaveProperty('$ai_input');
    expect(await spooledCount()).toBe(0);
  });

  it('sends metadata only, and says why, when no scrubber key is configured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const seen = stubPostHogFetch();
    await runTailAt(withPostHog, [textTurn('c', NOW - MIN)], NOW); // PostHog yes, scrubber no
    expect(await spooledCount()).toBe(0);

    await flushQueuedTurns(env.DB, withPostHog, NOW);
    const p = propsOf(seen);
    expect(p.text_status).toBe('scrub_unavailable');
    expect(p).not.toHaveProperty('$ai_input');
    expect(p).not.toHaveProperty('$ai_output_choices');
    const warned = warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(warned).toContain('conversation_text_dropped');
    // Neither the event nor the warning carries the words.
    expect(JSON.stringify(seen) + warned).not.toContain('Bob');
  });

  it('sends metadata only when the scrubber fails, never the raw text', async () => {
    anthropicMode = 'fail';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const seen = stubPostHogFetch();
    await runTailAt(withText, [textTurn('d', NOW - MIN)], NOW);
    expect(await spooledCount()).toBe(0);

    await flushQueuedTurns(env.DB, withText, NOW);
    const p = propsOf(seen);
    expect(p.text_status).toBe('scrub_failed');
    expect(p).not.toHaveProperty('$ai_input');
    expect(JSON.stringify(seen)).not.toContain('Bob');
  });

  it('reports text_status off for a record that carries no text', async () => {
    const seen = stubPostHogFetch();
    await runTailAt(withText, [turnMessage('e', NOW - MIN)], NOW);
    await flushQueuedTurns(env.DB, withText, NOW);
    const p = propsOf(seen);
    expect(p.text_status).toBe('off');
    expect(p).not.toHaveProperty('$ai_input');
  });

  it('stops a turn claiming scrubbed once the sweep has dropped its text', async () => {
    // A long PostHog outage: the turn is ingested with text, nothing sends it
    // for a day, the sweep takes the words. What eventually reaches PostHog
    // must say so rather than claim text it no longer has.
    const seen = stubPostHogFetch();
    await runTailAt(withText, [textTurn('f', NOW - MIN)], NOW);
    expect(await spooledCount()).toBe(1);

    const DAY = 24 * 60 * MIN;
    await flushQueuedTurns(env.DB, env as PostHogEnv, NOW + DAY + MIN); // no key: sweep only
    expect(await spooledCount()).toBe(0);
    expect(seen).toHaveLength(0);

    await flushQueuedTurns(env.DB, withText, NOW + DAY + 2 * MIN);
    const p = propsOf(seen);
    expect(p.text_status).toBe('spool_expired');
    expect(p).not.toHaveProperty('$ai_input');
    expect(p).not.toHaveProperty('$ai_output_choices');
  });

  it('leaves an already-emitted turn saying scrubbed when the sweep runs', async () => {
    // The other half of the same rule: `scrubbed` on an emitted turn is a true
    // account of what PostHog received, so expiry must not rewrite it.
    const seen = stubPostHogFetch();
    await runTailAt(withText, [textTurn('g', NOW - MIN)], NOW);
    await flushQueuedTurns(env.DB, withText, NOW);
    expect(propsOf(seen).text_status).toBe('scrubbed');

    await flushQueuedTurns(env.DB, withText, NOW + 25 * 60 * MIN);
    const row = await env.DB.prepare(
      `SELECT text_status FROM events WHERE event = 'chat_turn'`
    ).first<{ text_status: string }>();
    expect(row?.text_status).toBe('scrubbed');
  });

  it('does not re-spool or re-scrub when a tail batch is redelivered after emission', async () => {
    const seen = stubPostHogFetch();
    const batch = [textTurn('h', NOW - MIN)];
    await runTailAt(withText, batch, NOW);
    await flushQueuedTurns(env.DB, withText, NOW);
    expect(propsOf(seen).text_status).toBe('scrubbed');
    expect(await spooledCount()).toBe(0); // sent ⇒ forgotten

    // Cloudflare redelivers the same tail batch. The turn is already in
    // PostHog and its text deleted; nothing may recreate a row no sender will
    // ever select, and the scrubber must not be paid for a second time.
    const before = scrubCalls();
    expect(before).toBeGreaterThan(0); // the first pass really did call the scrubber
    await runTailAt(withText, batch, NOW + MIN);
    expect(await spooledCount()).toBe(0);
    expect(scrubCalls()).toBe(before);

    // …and the emitted turn keeps the status it was sent with.
    const row = await env.DB.prepare(
      `SELECT text_status FROM events WHERE event = 'chat_turn'`
    ).first<{ text_status: string }>();
    expect(row?.text_status).toBe('scrubbed');
  });

  it('does not re-scrub a turn whose text is still spooled', async () => {
    stubPostHogFetch();
    const batch = [textTurn('i', NOW - MIN)];
    await runTailAt(withText, batch, NOW);
    expect(await spooledCount()).toBe(1);

    const before = scrubCalls();
    expect(before).toBeGreaterThan(0);
    await runTailAt(withText, batch, NOW + 1000); // redelivered before the sender ran
    expect(scrubCalls()).toBe(before);
    expect(await spooledCount()).toBe(1);
  });

  it('does not revive text for a turn whose spool already expired', async () => {
    // The outage runs past the retention window and the tail batch is then
    // redelivered. `spool_expired` is the turn's final word: a replay must not
    // re-scrub, must not put the conversation back in D1 for another day, and
    // must not end up attaching text to a turn that says it lost it.
    const seen = stubPostHogFetch();
    const batch = [textTurn('j', NOW - MIN)];
    await runTailAt(withText, batch, NOW);
    const before = scrubCalls();
    expect(before).toBeGreaterThan(0);

    const DAY = 24 * 60 * MIN;
    await flushQueuedTurns(env.DB, env as PostHogEnv, NOW + DAY + MIN); // no key: sweep only
    expect(await spooledCount()).toBe(0);

    await runTailAt(withText, batch, NOW + DAY + 2 * MIN);
    expect(scrubCalls()).toBe(before);
    expect(await spooledCount()).toBe(0);

    await flushQueuedTurns(env.DB, withText, NOW + DAY + 3 * MIN);
    const p = propsOf(seen);
    expect(p.text_status).toBe('spool_expired');
    expect(p).not.toHaveProperty('$ai_input');
    expect(p).not.toHaveProperty('$ai_output_choices');
  });

  it('sweeps spooled text that was never sent after a day, even with no PostHog key', async () => {
    const insert = `INSERT INTO turn_text (turn_id, user_message, assistant_reply, created_at)
      VALUES (?1, ?2, ?3, ?4)`;
    await env.DB.prepare(insert)
      .bind(U('stale'), 'x', 'y', NOW - 25 * 60 * MIN)
      .run();
    await env.DB.prepare(insert)
      .bind(U('fresh'), 'x', 'y', NOW - 60 * MIN)
      .run();

    expect(await flushQueuedTurns(env.DB, env as PostHogEnv, NOW)).toBe(0); // no key: nothing sent…
    const { results } = await env.DB.prepare('SELECT turn_id FROM turn_text').all<{
      turn_id: string;
    }>();
    expect(results.map((r) => r.turn_id)).toEqual([U('fresh')]); // …but the day-old row is gone
  });
});

describe('tool calls', () => {
  it('emits one $ai_span per tool call under the turn, and tool_use blocks on the generation', async () => {
    const seen = stubPostHogFetch();
    const ts = NOW - MIN;
    await runTailAt(withPostHog, [toolTurn(turnMessage('a', ts), ts)], NOW);
    await flushQueuedTurns(env.DB, withPostHog, NOW);

    // Spans: one per call, parented to the turn, with deterministic ids and the call's own timing.
    const spans = spansFrom(seen);
    expect(spans.map((s) => (s.properties as R).$ai_span_name)).toEqual([
      'fetch_scripture',
      'search_translation_notes',
    ]);
    expect(spans.map((s) => s.uuid)).toEqual([toolCallUuid(U('a'), 0), toolCallUuid(U('a'), 1)]);
    for (const s of spans) {
      const p = s.properties as R;
      expect(s.distinct_id).toMatch(/^[0-9a-f]{64}$/);
      expect(p.$ai_trace_id).toBe(U('a'));
      expect(p.$ai_parent_id).toBe(U('a'));
      expect(p.$ai_session_id).toBe(U('a'));
      expect(p.server_id).toBe('translation-helps');
      expect(p.environment).toBe('test');
    }
    expect((spans[0]?.properties as R).$ai_latency).toBeCloseTo(0.812, 6);
    expect((spans[0]?.properties as R).$ai_is_error).toBe(false);
    expect((spans[1]?.properties as R).$ai_is_error).toBe(true);
    expect(spans[0]?.timestamp).toBe(new Date(ts - 3000).toISOString());

    // The generation: names for breakdowns, tool_use blocks for the Tools tab, the build that answered.
    const p = propsOf(seen);
    expect(p.tools_called).toEqual(['fetch_scripture', 'search_translation_notes']);
    expect(p.tool_call_count).toBe(2);
    expect(p.engine_version).toBe('2.49.0');
    expect(p.$ai_output_choices).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: toolCallUuid(U('a'), 0), name: 'fetch_scripture', input: {} },
          {
            type: 'tool_use',
            id: toolCallUuid(U('a'), 1),
            name: 'search_translation_notes',
            input: {},
          },
        ],
      },
    ]);
    expect(p).not.toHaveProperty('$ai_input'); // no text on this turn
  });

  it('places the scrubbed reply after the tool_use blocks when a turn has both', async () => {
    const seen = stubPostHogFetch();
    const ts = NOW - MIN;
    await runTailAt(withText, [toolTurn(textTurn('b', ts), ts)], NOW);
    await flushQueuedTurns(env.DB, withText, NOW);

    const p = propsOf(seen);
    expect(p.text_status).toBe('scrubbed');
    expect(p).toHaveProperty('$ai_input');
    const [choice] = p.$ai_output_choices as [{ content: Array<{ type: string }> }];
    expect(choice.content.map((c) => c.type)).toEqual(['tool_use', 'tool_use', 'text']);
    expect(spansFrom(seen)).toHaveLength(2);
  });

  it('never forwards tool arguments, even if an engine sent them', async () => {
    const seen = stubPostHogFetch();
    const ts = NOW - MIN;
    const withArgs = TOOL_CALLS(ts).map((c) => ({ ...c, args: { reference: 'Luke 2:3 for Bob' } }));
    await runTailAt(
      withPostHog,
      [toolTurn(turnMessage('c', ts), ts, { tool_calls: withArgs })],
      NOW
    );
    await flushQueuedTurns(env.DB, withPostHog, NOW);

    expect(spansFrom(seen)).toHaveLength(2);
    const everything =
      JSON.stringify(seen) +
      JSON.stringify((await env.DB.prepare('SELECT * FROM events').all()).results);
    expect(everything).not.toContain('reference');
    expect(everything).not.toContain('Luke 2:3');
    expect(everything).not.toContain('Bob');
  });

  it('resends spans with the same ids after a rejected batch', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubPostHogFetch(503);
    const ts = NOW - MIN;
    await runTailAt(withPostHog, [toolTurn(turnMessage('d', ts), ts)], NOW);
    expect(await flushQueuedTurns(env.DB, withPostHog, NOW)).toBe(0);

    vi.restoreAllMocks();
    const seen = stubPostHogFetch();
    expect(await flushQueuedTurns(env.DB, withPostHog, NOW + MIN)).toBe(1);
    expect(spansFrom(seen).map((s) => s.uuid)).toEqual([
      toolCallUuid(U('d'), 0),
      toolCallUuid(U('d'), 1),
    ]);
  });

  it('sends no spans and no tool blocks for a turn that recorded none', async () => {
    const seen = stubPostHogFetch();
    await runTailAt(withPostHog, [turnMessage('e', NOW - MIN)], NOW);
    await flushQueuedTurns(env.DB, withPostHog, NOW);

    expect(spansFrom(seen)).toHaveLength(0);
    const p = propsOf(seen);
    expect(p).not.toHaveProperty('tools_called');
    expect(p).not.toHaveProperty('tool_call_count');
    expect(p).not.toHaveProperty('$ai_output_choices');
  });
});
