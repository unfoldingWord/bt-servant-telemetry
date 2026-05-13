import { describe, expect, it, vi } from 'vitest';
import { postZulipMessage, type ZulipConfig } from '../../src/zulip/client.js';

const config: ZulipConfig = {
  site: 'https://example.zulipchat.com',
  botEmail: 'bot@example.com',
  botToken: 'secret-token',
  stream: 'telemetry',
  topic: 'daily-digest',
};

describe('postZulipMessage', () => {
  it('issues a POST against the messages endpoint with Basic auth and form-encoded body', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 }));
    const result = await postZulipMessage(config, '**hello** world', fetchMock);

    expect(result).toEqual({ ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://example.zulipchat.com/api/v1/messages');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    // Basic auth header is btoa("bot@example.com:secret-token").
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${btoa('bot@example.com:secret-token')}`);

    const body = new URLSearchParams(String(init?.body));
    expect(body.get('type')).toBe('stream');
    expect(body.get('to')).toBe('telemetry');
    expect(body.get('topic')).toBe('daily-digest');
    expect(body.get('content')).toBe('**hello** world');
  });

  it('returns reason=http with body when Zulip returns a non-2xx', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ msg: 'Invalid stream' }), { status: 400 }));
    const result = await postZulipMessage(config, 'irrelevant', fetchMock);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('http');
    if (result.reason !== 'http') throw new Error('unreachable');
    expect(result.status).toBe(400);
    expect(result.body).toContain('Invalid stream');
  });

  it('returns reason=transport when fetch rejects (DNS / TLS / connectivity) instead of throwing', async () => {
    // Network-level failure must honor the same non-throwing contract as
    // HTTP non-2xx, otherwise a Zulip outage aborts the rest of the
    // scheduled sweep after dedupe rows are already written.
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const result = await postZulipMessage(config, 'irrelevant', fetchMock);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('transport');
    if (result.reason !== 'transport') throw new Error('unreachable');
    expect(result.error).toContain('TypeError');
    expect(result.error).toContain('fetch failed');
  });

  it('round-trips multi-line markdown content via URL encoding', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 }));
    const markdown = '**Daily digest**\n- Distinct users: 42\n- Error rate: 0.5%';
    await postZulipMessage(config, markdown, fetchMock);
    const init = fetchMock.mock.calls[0]?.[1];
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('content')).toBe(markdown);
  });
});
