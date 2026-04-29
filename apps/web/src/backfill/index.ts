import type { CleanEvent } from '@bt-servant-telemetry/shared';
import { redact } from '../ingest/redact.js';
import { ingestBatch } from '../ingest/upsert.js';

export type BackfillEnv = {
  DB: D1Database;
  PII_HASH_SALT: string;
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  SOURCE_WORKER_NAME: string;
};

export type BackfillOptions = {
  since: number;
  until: number;
  pageSize?: number;
};

type FetchLike = typeof fetch;

type TelemetryMetadata = {
  id?: string;
  message?: string;
};

type TelemetryEvent = {
  $metadata?: TelemetryMetadata;
  source?: unknown;
  timestamp?: number;
};

type TelemetryQueryResponse = {
  result?: {
    events?: {
      events?: TelemetryEvent[];
      count?: number;
    };
  };
};

export type BackfillSummary = {
  pages: number;
  fetchedEvents: number;
  rawMessages: number;
  ingestedEvents: number;
  lastOffset: string | null;
  since: number;
  until: number;
};

type TelemetryPage = {
  events: TelemetryEvent[];
  nextOffset: string | null;
};

function buildTelemetryQueryBody(
  workerName: string,
  options: BackfillOptions,
  offset?: string
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    queryId: 'bt-servant-telemetry-backfill',
    timeframe: {
      from: options.since,
      to: options.until,
    },
    view: 'events',
    limit: options.pageSize ?? 100,
    parameters: {
      filterCombination: 'and',
      filters: [
        {
          key: '$metadata.service',
          operation: 'eq',
          type: 'string',
          value: workerName,
        },
      ],
    },
  };

  if (offset) body.offset = offset;
  return body;
}

function asRawMessage(event: TelemetryEvent): string | null {
  if (typeof event.source === 'string') return event.source;
  if (event.source && typeof event.source === 'object') return JSON.stringify(event.source);
  if (typeof event.$metadata?.message === 'string') {
    const message = event.$metadata.message.trim();
    if (message.startsWith('{') && message.endsWith('}')) return message;
  }
  return null;
}

async function queryTelemetryPage(
  env: BackfillEnv,
  options: BackfillOptions,
  fetchImpl: FetchLike,
  offset?: string
): Promise<TelemetryPage> {
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/observability/telemetry/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildTelemetryQueryBody(env.SOURCE_WORKER_NAME, options, offset)),
    }
  );

  if (!response.ok) {
    throw new Error(`Telemetry query failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as TelemetryQueryResponse;
  const events = payload.result?.events?.events ?? [];
  const nextOffset = events.at(-1)?.$metadata?.id ?? null;
  return { events, nextOffset };
}

async function redactAll(rawMessages: string[], salt: string): Promise<CleanEvent[]> {
  const clean: CleanEvent[] = [];
  for (const raw of rawMessages) {
    const evt = await redact(raw, salt);
    if (evt) clean.push(evt);
  }
  return clean;
}

export async function runBackfill(
  env: BackfillEnv,
  options: BackfillOptions,
  fetchImpl: FetchLike = fetch
): Promise<BackfillSummary> {
  const normalizedOptions: BackfillOptions = {
    ...options,
    pageSize: Math.min(options.pageSize ?? 100, 100),
  };
  let offset: string | undefined;
  let pages = 0;
  let fetchedEvents = 0;
  let rawMessages = 0;
  let ingestedEvents = 0;

  for (;;) {
    const page = await queryTelemetryPage(env, normalizedOptions, fetchImpl, offset);
    pages += 1;
    fetchedEvents += page.events.length;

    const messages = page.events.map(asRawMessage).filter((msg): msg is string => msg !== null);
    rawMessages += messages.length;

    const clean = await redactAll(messages, env.PII_HASH_SALT);
    if (clean.length > 0) {
      await ingestBatch(env.DB, clean);
      ingestedEvents += clean.length;
    }

    if (page.events.length === 0 || !page.nextOffset || page.nextOffset === offset) {
      return {
        pages,
        fetchedEvents,
        rawMessages,
        ingestedEvents,
        lastOffset: offset ?? null,
        since: normalizedOptions.since,
        until: normalizedOptions.until,
      };
    }

    offset = page.nextOffset;
  }
}
