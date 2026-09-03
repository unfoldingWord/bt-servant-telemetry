/**
 * Conversation stitching: consecutive turns by one user within the gap share a
 * session; a longer silence starts a new one. Derived entirely in this worker
 * from D1 - the engine emits no conversation id.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { redact } from '../../src/ingest/redact.js';
import { ingestBatch } from '../../src/ingest/upsert.js';
import { sessionGapMs, DEFAULT_SESSION_GAP_MINUTES } from '../../src/ingest/sessions.js';
import { sampleLogMessages } from '../fixtures/sample-tail-events.js';
import type { CleanEvent } from '@bt-servant-telemetry/shared';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  }
}

const SALT = 'test-salt-deterministic';
const BASE = sampleLogMessages.find((m) => m.includes('"event":"chat_turn"')) as string;
const T0 = 1788317687248;
const MIN = 60_000;

/** A chat_turn like the fixture's, with its own ids and timestamp. */
async function turn(id: string, ts: number, user = '15551234567'): Promise<CleanEvent> {
  const o = JSON.parse(BASE) as Record<string, unknown>;
  Object.assign(o, { turn_id: id, request_id: `req-${id}`, timestamp: ts, user_id: user });
  const evt = await redact(JSON.stringify(o), SALT);
  if (!evt) throw new Error('fixture failed to redact');
  return evt;
}

async function stored(id: string): Promise<{ session_id: string; session_turn_index: number }> {
  const row = await env.DB.prepare(
    'SELECT session_id, session_turn_index FROM events WHERE turn_id = ?'
  )
    .bind(id)
    .first<{ session_id: string; session_turn_index: number }>();
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await env.DB.exec('DELETE FROM events');
  await env.DB.exec('DELETE FROM users');
  await env.DB.exec('DELETE FROM user_active_days');
});

describe('sessionGapMs', () => {
  it('defaults to 30 minutes when unset or invalid', () => {
    expect(sessionGapMs(undefined)).toBe(DEFAULT_SESSION_GAP_MINUTES * MIN);
    expect(sessionGapMs('abc')).toBe(DEFAULT_SESSION_GAP_MINUTES * MIN);
    expect(sessionGapMs('0')).toBe(DEFAULT_SESSION_GAP_MINUTES * MIN);
  });
  it('honours a per-env override', () => {
    expect(sessionGapMs('120')).toBe(120 * MIN);
  });
});

describe('session stitching', () => {
  it('joins turns within the gap and numbers them', async () => {
    const a = await turn('a', T0);
    const b = await turn('b', T0 + 5 * MIN);
    await ingestBatch(env.DB, [a, b]);

    expect(a.session_id).toBe('a');
    expect(b.session_id).toBe('a'); // named after the first turn
    expect(a.session_turn_index).toBe(1);
    expect(b.session_turn_index).toBe(2);
    expect((await stored('b')).session_id).toBe('a');
  });

  it('starts a new session after a silence longer than the gap', async () => {
    const a = await turn('a', T0);
    const b = await turn('b', T0 + 2 * 60 * MIN);
    await ingestBatch(env.DB, [a, b]);

    expect(b.session_id).toBe('b');
    expect(b.session_turn_index).toBe(1);
  });

  it('stitches across separate tail batches via D1', async () => {
    await ingestBatch(env.DB, [await turn('a', T0)]);
    const b = await turn('b', T0 + 10 * MIN);
    await ingestBatch(env.DB, [b]); // new invocation: only D1 knows about "a"

    expect(b.session_id).toBe('a');
    expect(b.session_turn_index).toBe(2);
  });

  it('keeps different users in different sessions', async () => {
    const a = await turn('a', T0, '15551234567');
    const x = await turn('x', T0 + MIN, '15557654321');
    await ingestBatch(env.DB, [a, x]);

    expect(x.session_id).toBe('x');
    expect(x.session_turn_index).toBe(1);
  });

  it('orders a batch by timestamp before stitching', async () => {
    const a = await turn('a', T0);
    const b = await turn('b', T0 + 3 * MIN);
    await ingestBatch(env.DB, [b, a]); // delivered later-first

    expect(a.session_id).toBe('a');
    expect(b.session_id).toBe('a');
    expect(b.session_turn_index).toBe(2);
  });

  it('places a late turn after its chronological predecessor, not the newest row', async () => {
    // Persisted: a at t=0, b at t=100m (its own session). A late t=10m turn
    // must join a's session, not compare itself against b and start a third.
    await ingestBatch(env.DB, [await turn('a', T0)]);
    await ingestBatch(env.DB, [await turn('b', T0 + 100 * MIN)]);
    const late = await turn('late', T0 + 10 * MIN);
    await ingestBatch(env.DB, [late]);

    expect(late.session_id).toBe('a');
    expect(late.session_turn_index).toBe(2);
    expect(await stored('b')).toEqual({ session_id: 'b', session_turn_index: 1 });
  });

  it('recomputes already-stored successors when a late turn bridges a gap', async () => {
    // a at 0 and c at 40m were stored as separate sessions (40m > 30m gap).
    // A late b at 20m sits within the gap of both, so c now belongs to a.
    await ingestBatch(env.DB, [await turn('a', T0)]);
    await ingestBatch(env.DB, [await turn('c', T0 + 40 * MIN)]);
    expect((await stored('c')).session_id).toBe('c');

    await ingestBatch(env.DB, [await turn('b', T0 + 20 * MIN)]);

    expect(await stored('a')).toEqual({ session_id: 'a', session_turn_index: 1 });
    expect(await stored('b')).toEqual({ session_id: 'a', session_turn_index: 2 });
    expect(await stored('c')).toEqual({ session_id: 'a', session_turn_index: 3 });
  });

  it('recomputes the whole chain after a late turn, including a later new session', async () => {
    // Newer page ingested before the older one (page-by-page backfill).
    // Truth in time: a(0) b(10m) c(20m) | d(80m) e(85m).
    const later = [
      await turn('c', T0 + 20 * MIN),
      await turn('d', T0 + 80 * MIN),
      await turn('e', T0 + 85 * MIN),
    ];
    await ingestBatch(env.DB, later);
    await ingestBatch(env.DB, [await turn('a', T0), await turn('b', T0 + 10 * MIN)]);

    expect(await stored('a')).toEqual({ session_id: 'a', session_turn_index: 1 });
    expect(await stored('b')).toEqual({ session_id: 'a', session_turn_index: 2 });
    expect(await stored('c')).toEqual({ session_id: 'a', session_turn_index: 3 });
    expect(await stored('d')).toEqual({ session_id: 'd', session_turn_index: 1 });
    expect(await stored('e')).toEqual({ session_id: 'd', session_turn_index: 2 });
  });

  it('never hands two concurrent turns the same session_turn_index', async () => {
    await ingestBatch(env.DB, [await turn('a', T0)]);
    const turns = await Promise.all(
      Array.from({ length: 6 }, (_, i) => turn(`t${i}`, T0 + (i + 1) * MIN))
    );
    // Separate invocations racing for the same user: each is a separate batch.
    await Promise.all(turns.map((t) => ingestBatch(env.DB, [t])));

    const rows = await env.DB.prepare(
      `SELECT session_id, session_turn_index FROM events
        WHERE event = 'chat_turn' ORDER BY session_turn_index`
    ).all<{ session_id: string; session_turn_index: number }>();
    expect(rows.results.map((r) => r.session_id)).toEqual(Array(7).fill('a'));
    expect(rows.results.map((r) => r.session_turn_index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('is idempotent under a replayed delivery', async () => {
    const a = await turn('a', T0);
    await ingestBatch(env.DB, [a]);
    await ingestBatch(env.DB, [await turn('a', T0)]); // same turn again

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE turn_id = 'a'`
    ).first<{ n: number }>();
    expect(rows?.n).toBe(1);
    expect((await stored('a')).session_id).toBe('a');
  });
});
