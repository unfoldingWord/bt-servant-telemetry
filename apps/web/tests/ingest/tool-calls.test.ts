/**
 * Tool calls on a turn (ingest/tool-calls.ts).
 *
 * The engine sends names, servers and timings; nothing else may get through.
 * Three properties matter: a malformed or over-long list is trimmed rather
 * than trusted, ids are deterministic so a resend is idempotent, and the
 * `tool_use` blocks PostHog reads carry names with empty inputs.
 */
import { describe, it, expect } from 'vitest';
import { NO_TURN_FACTS, type CleanEvent } from '@bt-servant-telemetry/shared';
import {
  MAX_TOOL_CALLS,
  parseToolCalls,
  toolCallUuid,
  toolNames,
  toolUseBlocks,
} from '../../src/ingest/tool-calls.js';

const TURN = '7ca7aedd-cc08-494d-9102-a1277a0f2775';
const CALL = {
  name: 'fetch_scripture',
  server_id: 'translation-helps',
  started_at: 1_750_000_000_000,
  duration_ms: 812,
  ok: true,
};

function turn(tool_calls: CleanEvent['tool_calls']): CleanEvent {
  return {
    ...NO_TURN_FACTS,
    event: 'chat_turn',
    ts: 1_750_000_004_200,
    level: null,
    org: 'unfoldingWord',
    user_hash: 'h',
    client_id: 'whatsapp',
    request_id: 'req-1',
    total_ms: null,
    duration_ms: 4200,
    chat_type: 'private',
    transport: 'final',
    tool_name: null,
    server_id: null,
    first_interaction: null,
    turn_id: TURN,
    tool_calls,
  };
}

describe('parseToolCalls', () => {
  it('keeps exactly the five fields and drops anything else on an item', () => {
    const parsed = parseToolCalls([{ ...CALL, args: { reference: 'John 3:16' }, result: 'x' }]);
    expect(parsed).toEqual([CALL]);
    expect(JSON.stringify(parsed)).not.toContain('John 3:16');
  });

  it('accepts a null server for engine-hosted tools', () => {
    expect(parseToolCalls([{ ...CALL, name: 'execute_code', server_id: null }])).toEqual([
      { ...CALL, name: 'execute_code', server_id: null },
    ]);
  });

  it('skips malformed items and returns null for a non-array', () => {
    expect(parseToolCalls([CALL, { name: '' }, { name: 'x' }, 'junk', null])).toEqual([CALL]);
    expect(parseToolCalls(undefined)).toBeNull();
    expect(parseToolCalls('fetch_scripture')).toBeNull();
    expect(parseToolCalls({ name: 'fetch_scripture' })).toBeNull();
  });

  it('caps the list', () => {
    const many = Array.from({ length: MAX_TOOL_CALLS + 10 }, () => CALL);
    expect(parseToolCalls(many)).toHaveLength(MAX_TOOL_CALLS);
  });
});

describe('toolCallUuid', () => {
  it('derives a valid, deterministic UUID from the turn id and index', () => {
    const a = toolCallUuid(TURN, 0);
    expect(a).toBe('7ca7aedd-cc08-494d-9102-a1277a0f0000');
    expect(toolCallUuid(TURN, 0)).toBe(a);
    expect(toolCallUuid(TURN, 1)).toBe('7ca7aedd-cc08-494d-9102-a1277a0f0001');
    expect(toolCallUuid(TURN, 17)).toBe('7ca7aedd-cc08-494d-9102-a1277a0f0011');
    expect(a).not.toBe(TURN); // never collides with the generation's own uuid
  });

  it('falls back to a random UUID when the turn id is not one', () => {
    const a = toolCallUuid('turn-abc', 0);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(toolCallUuid('turn-abc', 0)).not.toBe(a);
  });
});

describe('toolUseBlocks / toolNames', () => {
  it('renders Anthropic-style blocks with names and EMPTY inputs, in call order', () => {
    const evt = turn([CALL, { ...CALL, name: 'search_notes', ok: false }]);
    expect(toolUseBlocks(evt)).toEqual([
      { type: 'tool_use', id: toolCallUuid(TURN, 0), name: 'fetch_scripture', input: {} },
      { type: 'tool_use', id: toolCallUuid(TURN, 1), name: 'search_notes', input: {} },
    ]);
    expect(toolNames(evt)).toEqual(['fetch_scripture', 'search_notes']);
  });

  it('is empty for a turn with no tool calls, or an engine that sent none', () => {
    expect(toolUseBlocks(turn([]))).toEqual([]);
    expect(toolUseBlocks(turn(null))).toEqual([]);
    expect(toolNames(turn(null))).toEqual([]);
  });
});
