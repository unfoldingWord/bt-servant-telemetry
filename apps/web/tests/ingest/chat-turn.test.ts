/**
 * chat_turn ingest — the engine ↔ telemetry contract.
 *
 * bt-servant-worker emits one `chat_turn` line per addressed turn carrying the
 * per-turn LLM facts (model, summed tokens, mode, iterations, exit reason).
 * Before this event was whitelisted, `redact()` dropped the entire record at the
 * event-name gate, so none of it ever reached D1.
 *
 * Two failure modes this file exists to catch, both silent in production:
 *   1. `chat_turn` falls out of KNOWN_EVENTS again → the whole row vanishes.
 *   2. A field is added to the worker's payload but not to the extractor →
 *      the row lands with that column NULL and nobody notices.
 *
 * The JSON below is the literal shape the worker's console-path-invariance
 * golden test asserts it emits. Keep the two in sync.
 */

import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { redact } from '../../src/ingest/redact.js';
import { ingestBatch } from '../../src/ingest/upsert.js';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  }
}

const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
afterEach(() => warnSpy.mockClear());

const SALT = 'test-salt-deterministic';

const CHAT_TURN_JSON = JSON.stringify({
  event: 'chat_turn',
  request_id: 'req-789',
  timestamp: 1750000000000,
  turn_id: 'turn-abc',
  user_id: 'whatsapp:15551234567',
  org: 'unfoldingWord',
  client_id: 'whatsapp',
  transport: 'whatsapp',
  chat_type: 'private',
  response_language: 'en',
  user_country: 'US',
  edge_country: 'US',
  mode: 'dbs-coach',
  mode_switched_to: null,
  language: 'hindi',
  language_source: 'trigger',
  model: 'claude-sonnet-4-20250514',
  iterations: 3,
  exit_reason: 'done',
  stop_reason: 'end_turn',
  mcp_calls_made: 2,
  input_tokens: 120,
  output_tokens: 340,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 1500,
  billable_input_tokens: 270,
  duration_ms: 4200,
  had_inbound_voice: false,
  had_outbound_voice: true,
});

describe('chat_turn redaction', () => {
  it('is whitelisted and survives the event-name gate', async () => {
    const evt = await redact(CHAT_TURN_JSON, SALT);
    expect(evt, 'chat_turn must be in KNOWN_EVENTS').not.toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('extracts every per-turn LLM fact', async () => {
    const evt = await redact(CHAT_TURN_JSON, SALT);
    expect(evt).not.toBeNull();
    const e = evt as NonNullable<typeof evt>;
    expect(e.turn_id).toBe('turn-abc');
    expect(e.model).toBe('claude-sonnet-4-20250514');
    expect(e.iterations).toBe(3);
    expect(e.exit_reason).toBe('done');
    expect(e.stop_reason).toBe('end_turn');
    expect(e.mcp_calls_made).toBe(2);
    expect(e.input_tokens).toBe(120);
    expect(e.output_tokens).toBe(340);
    expect(e.cache_read_input_tokens).toBe(1500);
    expect(e.billable_input_tokens).toBe(270);
  });

  it('extracts mode, language and voice dimensions', async () => {
    const evt = await redact(CHAT_TURN_JSON, SALT);
    expect(evt?.mode).toBe('dbs-coach');
    expect(evt?.mode_switched_to).toBeNull();
    expect(evt?.language).toBe('hindi');
    expect(evt?.language_source).toBe('trigger');
    expect(evt?.response_language).toBe('en');
    expect(evt?.user_country).toBe('US');
    expect(evt?.had_inbound_voice).toBe(false);
    expect(evt?.had_outbound_voice).toBe(true);
  });

  it('still hashes the raw user_id away', async () => {
    const evt = await redact(CHAT_TURN_JSON, SALT);
    expect(evt?.user_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(evt)).not.toContain('15551234567');
  });

  it('leaves turn facts null for a non-chat_turn event', async () => {
    const other = JSON.stringify({
      event: 'request_received',
      request_id: 'req-1',
      timestamp: 1750000000000,
      client_id: 'web',
      user_id: 'a@example.com',
    });
    const evt = await redact(other, SALT);
    expect(evt?.turn_id).toBeNull();
    expect(evt?.input_tokens).toBeNull();
    expect(evt?.model).toBeNull();
  });
});

describe('chat_turn persistence', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM events');
    await env.DB.exec('DELETE FROM users');
    await env.DB.exec('DELETE FROM user_active_days');
  });

  it('writes every turn fact through to D1', async () => {
    const evt = await redact(CHAT_TURN_JSON, SALT);
    await ingestBatch(env.DB, [evt!]);

    const row = await env.DB.prepare(
      `SELECT turn_id, mode, language, model, iterations, exit_reason, stop_reason,
              input_tokens, output_tokens, billable_input_tokens,
              had_inbound_voice, had_outbound_voice
         FROM events WHERE event = 'chat_turn'`
    ).first();

    expect(row).not.toBeNull();
    expect(row?.turn_id).toBe('turn-abc');
    expect(row?.mode).toBe('dbs-coach');
    expect(row?.model).toBe('claude-sonnet-4-20250514');
    expect(row?.iterations).toBe(3);
    expect(row?.input_tokens).toBe(120);
    expect(row?.billable_input_tokens).toBe(270);
    // SQLite has no boolean type — booleans round-trip as 0/1.
    expect(row?.had_inbound_voice).toBe(0);
    expect(row?.had_outbound_voice).toBe(1);
  });

  it('counts a chat_turn toward the user activity tables', async () => {
    const evt = await redact(CHAT_TURN_JSON, SALT);
    await ingestBatch(env.DB, [evt!]);

    const users = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    expect(users?.n).toBe(1);
  });
});
