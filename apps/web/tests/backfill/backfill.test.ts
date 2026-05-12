import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runBackfill } from '../../src/backfill/index.js';
import { sampleLogMessages } from '../fixtures/sample-tail-events.js';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    PII_HASH_SALT: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}

type MockEvent = {
  $metadata: { id: string; message?: string };
  source?: unknown;
};

function buildApiEvent(id: string, source: unknown): MockEvent {
  return {
    $metadata: { id },
    source,
  };
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM events');
  await env.DB.exec('DELETE FROM users');
});

describe('runBackfill', () => {
  it('queries telemetry, redacts events, and ingests them into D1', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              events: {
                events: [
                  buildApiEvent('evt-1', sampleLogMessages[0]),
                  buildApiEvent('evt-2', JSON.parse(sampleLogMessages[9]!)),
                ],
              },
            },
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              events: {
                events: [],
              },
            },
          })
        )
      );

    const summary = await runBackfill(
      {
        ...env,
        CF_API_TOKEN: 'token',
        CF_ACCOUNT_ID: 'account-id',
        SOURCE_WORKER_NAME: 'bt-servant-worker',
      },
      {
        since: 1776700000000,
        until: 1777060000000,
        pageSize: 100,
      },
      fetchMock
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/accounts/account-id/workers/observability/telemetry/query');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer token',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      queryId: 'bt-servant-telemetry-backfill',
      view: 'events',
      limit: 100,
      timeframe: { from: 1776700000000, to: 1777060000000 },
      parameters: {
        filters: [
          {
            key: '$metadata.service',
            operation: 'eq',
            value: 'bt-servant-worker',
          },
        ],
      },
    });

    expect(summary).toMatchObject({
      pages: 2,
      fetchedEvents: 2,
      rawMessages: 2,
      ingestedEvents: 2,
    });

    const events = await env.DB.prepare(
      'SELECT event, request_id, user_hash, tool_name FROM events ORDER BY ts ASC'
    ).all();
    expect(events.results).toHaveLength(2);
    expect(events.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'mcp_tool_call_error',
          request_id: 'a991e72a-a86c-4d94-9cb6-b30a679bd8c9',
          user_hash: null,
          tool_name: 'fetch_translation_word',
        }),
        expect.objectContaining({
          event: 'request_received',
          request_id: 'a991e72a-a86c-4d94-9cb6-b30a679bd8c9',
        }),
      ])
    );

    const users = await env.DB.prepare('SELECT user_hash, org, client_id FROM users').all();
    expect(users.results).toHaveLength(1);
  });

  it('paginates using the last metadata id as offset', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              events: {
                events: [buildApiEvent('evt-1', sampleLogMessages[0])],
              },
            },
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              events: {
                events: [buildApiEvent('evt-2', sampleLogMessages[1])],
              },
            },
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              events: {
                events: [],
              },
            },
          })
        )
      );

    const summary = await runBackfill(
      {
        ...env,
        CF_API_TOKEN: 'token',
        CF_ACCOUNT_ID: 'account-id',
        SOURCE_WORKER_NAME: 'bt-servant-worker',
      },
      {
        since: 1776700000000,
        until: 1777060000000,
      },
      fetchMock
    );

    expect(summary).toMatchObject({
      pages: 3,
      fetchedEvents: 2,
      rawMessages: 2,
      ingestedEvents: 2,
      lastOffset: 'evt-2',
    });

    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      offset: 'evt-1',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      offset: 'evt-2',
    });
  });
});
