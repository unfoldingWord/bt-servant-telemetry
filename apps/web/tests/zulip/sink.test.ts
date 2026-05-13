import { describe, expect, it, vi } from 'vitest';
import { createZulipSink } from '../../src/zulip/sink.js';
import type { ZulipConfig } from '../../src/zulip/client.js';
import type { PostIntent } from '../../src/config/sink.js';

const config: ZulipConfig = {
  site: 'https://example.zulipchat.com',
  botEmail: 'bot@example.com',
  botToken: 'secret-token',
  stream: 'telemetry',
  topic: 'daily-digest',
};

describe('createZulipSink', () => {
  it('forwards each intent kind to the Zulip transport with its markdown body', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 }));
    const sink = createZulipSink(config, fetchMock);

    const intents: PostIntent[] = [
      { kind: 'reconcile', markdown: 'reconcile body' },
      { kind: 'digest', markdown: 'digest body' },
      { kind: 'alert', alertKind: 'worker_offline', markdown: 'alert body' },
      { kind: 'milestone', milestone: 100, markdown: 'milestone body' },
    ];
    for (const intent of intents) await sink(intent);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const bodies = fetchMock.mock.calls.map((call) =>
      new URLSearchParams(String(call[1]?.body)).get('content')
    );
    expect(bodies).toEqual(['reconcile body', 'digest body', 'alert body', 'milestone body']);
  });

  it('logs and swallows a failed POST so a Zulip outage cannot crash the sweep', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('rate limited', { status: 429 }));
    const sink = createZulipSink(config, fetchMock);

    await expect(
      sink({ kind: 'alert', alertKind: 'error_rate_high', markdown: 'irrelevant' })
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toContain('kind=alert');
    expect(message).toContain('status=429');
    expect(message).toContain('rate limited');
    errorSpy.mockRestore();
  });
});
