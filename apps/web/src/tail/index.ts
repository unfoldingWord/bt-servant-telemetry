import { redact } from '../ingest/redact.js';
import { ingestBatch } from '../ingest/upsert.js';
import type { CleanEvent } from '@bt-servant-telemetry/shared';

type Env = {
  DB: D1Database;
  PII_HASH_SALT: string;
};

/**
 * Each TailItem may contain multiple log calls. Each `console.log` in
 * bt-servant-worker emits a JSON-stringified event object as the first
 * argument; we extract that and pass it through `redact()`.
 */
function extractLogStrings(items: TraceItem[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    for (const entry of item.logs) {
      const first = entry.message[0];
      if (typeof first === 'string') out.push(first);
    }
  }
  return out;
}

async function redactAll(rawMessages: string[], salt: string): Promise<CleanEvent[]> {
  const clean: CleanEvent[] = [];
  for (const raw of rawMessages) {
    const evt = await redact(raw, salt);
    if (evt) clean.push(evt);
  }
  return clean;
}

export async function tailHandler(
  events: TraceItem[],
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  const rawMessages = extractLogStrings(events);
  if (rawMessages.length === 0) return;
  const clean = await redactAll(rawMessages, env.PII_HASH_SALT);
  if (clean.length === 0) return;
  await ingestBatch(env.DB, clean);
}
