import { describe, it, expect } from 'vitest';
import { redact, hashUserId } from '../../src/ingest/redact.js';
import { sampleLogMessages } from '../fixtures/sample-tail-events.js';

const SALT = 'test-salt-deterministic';

describe('hashUserId', () => {
  it('produces a 64-char hex string', async () => {
    const h = await hashUserId(SALT, 'whatsapp', '15551234567');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same inputs', async () => {
    const a = await hashUserId(SALT, 'whatsapp', '15551234567');
    const b = await hashUserId(SALT, 'whatsapp', '15551234567');
    expect(a).toBe(b);
  });

  it('differs across client_id namespaces', async () => {
    const phoneHash = await hashUserId(SALT, 'whatsapp', '15551234567');
    const webHash = await hashUserId(SALT, 'web', '15551234567');
    expect(phoneHash).not.toBe(webHash);
  });

  it('differs across users', async () => {
    const a = await hashUserId(SALT, 'web', 'a@example.com');
    const b = await hashUserId(SALT, 'web', 'b@example.com');
    expect(a).not.toBe(b);
  });
});

describe('redact', () => {
  it('parses a request_received event with whatsapp phone user_id', async () => {
    const evt = await redact(sampleLogMessages[1]!, SALT);
    expect(evt).not.toBeNull();
    expect(evt!.event).toBe('request_received');
    expect(evt!.client_id).toBe('whatsapp');
    expect(evt!.org).toBe('unfoldingWord');
    expect(evt!.user_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(evt!.transport).toBe('callback');
    expect(evt!.chat_type).toBe('private');
  });

  it('parses a request_received event with web email user_id', async () => {
    const evt = await redact(sampleLogMessages[0]!, SALT);
    expect(evt).not.toBeNull();
    expect(evt!.client_id).toBe('web');
    expect(evt!.user_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('captures total_ms on process_chat_complete and drops the response field', async () => {
    const evt = await redact(sampleLogMessages[4]!, SALT);
    expect(evt).not.toBeNull();
    expect(evt!.event).toBe('process_chat_complete');
    expect(evt!.total_ms).toBe(6231);
    expect(evt!.user_hash).toBeNull();
    expect(evt).not.toHaveProperty('response');
  });

  it('marks error events with level=error and captures tool/server identifiers', async () => {
    const evt = await redact(sampleLogMessages[9]!, SALT);
    expect(evt).not.toBeNull();
    expect(evt!.event).toBe('mcp_tool_call_error');
    expect(evt!.level).toBe('error');
    expect(evt!.server_id).toBe('translation-helps');
    expect(evt!.tool_name).toBe('fetch_translation_word');
    expect(evt!.duration_ms).toBe(15);
  });

  it('drops args, error message, stack, and code fields entirely', async () => {
    for (const raw of sampleLogMessages) {
      const evt = await redact(raw, SALT);
      if (!evt) continue;
      expect(evt).not.toHaveProperty('args');
      expect(evt).not.toHaveProperty('error');
      expect(evt).not.toHaveProperty('stack');
      expect(evt).not.toHaveProperty('code');
      expect(evt).not.toHaveProperty('response');
    }
  });

  it('returns null for unparseable JSON', async () => {
    expect(await redact('not json', SALT)).toBeNull();
    expect(await redact('[]', SALT)).toBeNull();
    expect(await redact('"string"', SALT)).toBeNull();
  });

  it('returns null for unknown event names (schema-drift guard)', async () => {
    const raw = JSON.stringify({
      event: 'totally_new_event_we_have_not_seen',
      request_id: 'xyz',
      timestamp: 1700000000000,
    });
    expect(await redact(raw, SALT)).toBeNull();
  });

  it('returns null when required fields are missing', async () => {
    const noEvent = JSON.stringify({ request_id: 'x', timestamp: 1 });
    const noRequestId = JSON.stringify({ event: 'request_received', timestamp: 1 });
    const noTs = JSON.stringify({ event: 'request_received', request_id: 'x' });
    expect(await redact(noEvent, SALT)).toBeNull();
    expect(await redact(noRequestId, SALT)).toBeNull();
    expect(await redact(noTs, SALT)).toBeNull();
  });
});

describe('redact PII guarantees across the full fixture set', () => {
  it('never leaks raw phone digits, emails, response text, or stack content', async () => {
    const cleaned = await Promise.all(sampleLogMessages.map((m) => redact(m, SALT)));
    const json = JSON.stringify(cleaned);
    expect(json).not.toMatch(/15551234567/);
    expect(json).not.toMatch(/test-user@example\.com/);
    expect(json).not.toMatch(/REDACTED_RESPONSE/);
    expect(json).not.toMatch(/parseJsonRpcResponse/);
    expect(json).not.toMatch(/CodeExecutionError/);
  });
});
