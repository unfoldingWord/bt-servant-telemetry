/**
 * Failed turns (exit_reason = error).
 *
 * Before the engine emitted these, an outage read as silence: every turn that
 * reached PostHog had succeeded, so an error rate could only ever be zero.
 * A failed turn is a real chat_turn with no answer: no tokens, no steps, a
 * bounded error class, and — the property that matters — it still reaches
 * PostHog as a generation flagged `$ai_is_error`, so "how often did we fail
 * people" is one filter away.
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

/** What the engine emits when a turn fails for good (worker: buildFailedChatTurnRecord). */
const FAILED_TURN = JSON.stringify({
  event: 'chat_turn',
  request_id: 'req-fail',
  timestamp: 1750000000000,
  turn_id: 'b2c5e0d4-6f6b-4a6e-8c1e-0d9d5f1b2a33',
  user_id: 'whatsapp:15551234567',
  org: 'unfoldingWord',
  client_id: 'whatsapp',
  transport: 'final',
  chat_type: 'private',
  user_country: 'US',
  edge_country: 'US',
  model: 'claude-sonnet-4-6',
  exit_reason: 'error',
  error_type: 'MCPError',
  engine_version: '2.49.0',
  tool_calls: [],
  had_inbound_voice: false,
  had_outbound_voice: false,
  user_message: 'What does Luke 2:3 say?',
  assistant_reply: '',
});

describe('a failed turn on the wire', () => {
  it('is a chat_turn with exit_reason error and a bounded error_type, and nothing else it cannot know', async () => {
    const evt = await redact(FAILED_TURN, SALT);
    expect(evt).not.toBeNull();
    const e = evt as NonNullable<typeof evt>;
    expect(e.exit_reason).toBe('error');
    expect(e.error_type).toBe('MCPError');
    expect(e.model).toBe('claude-sonnet-4-6');
    expect(e.input_tokens).toBeNull();
    expect(e.output_tokens).toBeNull();
    expect(e.iterations).toBeNull();
    expect(e.tool_calls).toEqual([]);
    expect(e.user_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('maps to a generation flagged as an error, with zero tokens so PostHog accepts it', async () => {
    const evt = (await redact(FAILED_TURN, SALT)) as NonNullable<
      Awaited<ReturnType<typeof redact>>
    >;
    const p = toGenerationProperties(evt);
    expect(p.$ai_is_error).toBe(true);
    expect(p.$ai_error).toBe('MCPError');
    expect(p.exit_reason).toBe('error');
    expect(p.error_type).toBe('MCPError');
    expect(p.$ai_model).toBe('claude-sonnet-4-6');
    expect(p.$ai_input_tokens).toBe(0);
    expect(p.$ai_output_tokens).toBe(0);
    expect(p).not.toHaveProperty('$ai_latency');
    // The person picks up country too, so People can be filtered by it (Q1, Q9).
    expect(p.$set).toEqual({ org: 'unfoldingWord', client_id: 'whatsapp', user_country: 'US' });
  });

  it('leaves a successful turn unflagged', async () => {
    const ok = JSON.parse(FAILED_TURN) as Record<string, unknown>;
    Object.assign(ok, {
      exit_reason: 'done',
      error_type: undefined,
      input_tokens: 4,
      output_tokens: 20,
    });
    const evt = (await redact(JSON.stringify(ok), SALT)) as NonNullable<
      Awaited<ReturnType<typeof redact>>
    >;
    const p = toGenerationProperties(evt);
    expect(p).not.toHaveProperty('$ai_is_error');
    expect(p).not.toHaveProperty('$ai_error');
    expect(p).not.toHaveProperty('error_type');
    expect(p.$ai_input_tokens).toBe(4);
  });
});

describe('a failed turn in D1', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM events');
    await env.DB.exec('DELETE FROM users');
    await env.DB.exec('DELETE FROM user_active_days');
  });

  it('round-trips error_type, engine_version and tool_calls through the events table', async () => {
    const evt = (await redact(FAILED_TURN, SALT)) as NonNullable<
      Awaited<ReturnType<typeof redact>>
    >;
    await ingestBatch(env.DB, [evt]);
    const row = await env.DB.prepare(
      `SELECT ${EVENT_COLUMN_LIST} FROM events WHERE event = 'chat_turn'`
    ).first<EventRow>();
    expect(row).not.toBeNull();
    const back = rowToCleanEvent(row as EventRow);
    expect(back.exit_reason).toBe('error');
    expect(back.error_type).toBe('MCPError');
    expect(back.engine_version).toBe('2.49.0');
    expect(back.tool_calls).toEqual([]);
  });
});
