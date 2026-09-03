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

  it('is idempotent under a replayed delivery', async () => {
    const a = await turn('a', T0);
    await ingestBatch(env.DB, [a]);
    await ingestBatch(env.DB, [await turn('a', T0)]); // same turn again

    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE turn_id = 'a'`).first<{ n: number }>();
    expect(rows?.n).toBe(1);
    expect((await stored('a')).session_id).toBe('a');
  });
});
