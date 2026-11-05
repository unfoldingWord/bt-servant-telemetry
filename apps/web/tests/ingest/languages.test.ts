/**
 * Languages per turn (migration 0008).
 *
 * input_language is what the user wrote in, detected by the engine and carried
 * on chat_turn. target_language is what they are translating INTO, which only
 * the ingest scrubber may stamp: an engine cannot know it, so a value on the
 * wire is ignored rather than trusted. Both must survive D1 and reach the
 * generation, and the target language must also land on the person.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { redact } from '../../src/ingest/redact.js';
import { ingestBatch } from '../../src/ingest/upsert.js';
import { toGenerationProperties } from '../../src/ingest/posthog.js';
import { rowToCleanEvent, EVENT_COLUMN_LIST, type EventRow } from '../../src/ingest/event-row.js';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  }
}

const SALT = 'test-salt-deterministic';

const TURN = JSON.stringify({
  event: 'chat_turn',
  request_id: 'req-lang',
  timestamp: 1750000000000,
  turn_id: 'c3d6f1e5-7a7c-4b7f-9d2f-1e0e6a2c3b44',
  user_id: 'whatsapp:15551234567',
  org: 'unfoldingWord',
  client_id: 'whatsapp',
  transport: 'final',
  chat_type: 'private',
  response_language: 'en',
  input_language: 'sw',
  user_country: 'TZ',
  edge_country: 'US',
  model: 'claude-sonnet-4-6',
  iterations: 1,
  exit_reason: 'done',
  stop_reason: 'end_turn',
  mcp_calls_made: 1,
  input_tokens: 10,
  output_tokens: 40,
  duration_ms: 900,
  had_inbound_voice: false,
  had_outbound_voice: false,
  // An engine must not be able to assert this; only the scrubber stamps it.
  target_language: 'Klingon',
});

async function cleanTurn(): Promise<NonNullable<Awaited<ReturnType<typeof redact>>>> {
  const evt = await redact(TURN, SALT);
  expect(evt).not.toBeNull();
  return evt as NonNullable<typeof evt>;
}

describe('languages on the wire', () => {
  it('takes input_language from the engine and never target_language', async () => {
    const e = await cleanTurn();
    expect(e.input_language).toBe('sw');
    expect(e.target_language).toBeNull();
  });

  it('puts both on the generation, and the target language on the person', async () => {
    const e = await cleanTurn();
    e.target_language = 'Tetun';
    const p = toGenerationProperties(e);
    expect(p.input_language).toBe('sw');
    expect(p.target_language).toBe('Tetun');
    expect(p.$set).toMatchObject({ target_language: 'Tetun', user_country: 'TZ' });
  });

  it('leaves both off the generation when unknown, rather than sending null', async () => {
    const e = await cleanTurn();
    e.input_language = null;
    const p = toGenerationProperties(e);
    expect(p).not.toHaveProperty('input_language');
    expect(p).not.toHaveProperty('target_language');
    expect(p.$set).not.toHaveProperty('target_language');
  });
});

describe('languages in D1', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM events');
    await env.DB.exec('DELETE FROM users');
    await env.DB.exec('DELETE FROM user_active_days');
  });

  it('round-trips both columns through the events table to the sender', async () => {
    const e = await cleanTurn();
    e.target_language = 'Tetun';
    await ingestBatch(env.DB, [e]);
    const row = await env.DB.prepare(
      `SELECT ${EVENT_COLUMN_LIST} FROM events WHERE event = 'chat_turn'`
    ).first<EventRow>();
    expect(row).not.toBeNull();
    const back = rowToCleanEvent(row as EventRow);
    expect(back.input_language).toBe('sw');
    expect(back.target_language).toBe('Tetun');
  });
});
