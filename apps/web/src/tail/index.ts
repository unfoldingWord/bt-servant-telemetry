import { redact } from '../ingest/redact.js';
import { ingestBatch } from '../ingest/upsert.js';
import { sessionGapMs } from '../ingest/sessions.js';
import { scrubConversation, type ScrubEnv } from '../ingest/scrub.js';
import {
  extractConversationText,
  loadSpoolSkips,
  spoolScrubbedText,
  TEXT_STATUS,
  warnTextDropped,
  type ConversationText,
  type SpooledText,
  type SpoolSkip,
} from '../ingest/text.js';
import type { CleanEvent } from '@bt-servant-telemetry/shared';

type Env = ScrubEnv & {
  DB: D1Database;
  PII_HASH_SALT: string;
  /** Inactivity gap that splits a user's turns into conversations. Default 30. */
  SESSION_GAP_MINUTES?: string;
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

/**
 * Decide one turn's text fate: stamp `text_status` on the event and return
 * the scrubbed row to spool, or null when nothing may be spooled. The raw
 * text is only ever held in this function's arguments.
 *
 * `skip` is set when D1 says this turn has been here before — a redelivered
 * tail batch. Either answer means the scrubber must not run again: the words
 * are already spooled, or the turn is already in PostHog and its text gone.
 */
async function scrubTurn(
  evt: CleanEvent,
  text: ConversationText | undefined,
  skip: SpoolSkip | undefined,
  env: ScrubEnv
): Promise<SpooledText | null> {
  if (!text) {
    evt.text_status = TEXT_STATUS.off;
    return null;
  }
  if (skip !== undefined) {
    evt.text_status = skip === 'emitted' ? TEXT_STATUS.alreadyEmitted : TEXT_STATUS.scrubbed;
    return null;
  }
  if (text.userMessage.trim() === '' && text.assistantReply.trim() === '') {
    evt.text_status = TEXT_STATUS.empty;
    return null;
  }
  const result = await scrubConversation(text, env);
  if (!result.ok) {
    const status = result.reason === 'no_api_key' ? TEXT_STATUS.unavailable : TEXT_STATUS.failed;
    evt.text_status = status;
    warnTextDropped(evt, status, result.detail ?? result.reason);
    return null;
  }
  evt.text_status = TEXT_STATUS.scrubbed;
  return {
    turn_id: text.turnId,
    user_message: result.userMessage,
    assistant_reply: result.assistantReply,
  };
}

/** Scrub every chat turn's text in parallel; returns only what may be spooled. */
async function prepareConversationText(
  db: D1Database,
  clean: CleanEvent[],
  rawMessages: string[],
  env: ScrubEnv
): Promise<SpooledText[]> {
  const texts = new Map<string, ConversationText>();
  for (const raw of rawMessages) {
    const text = extractConversationText(raw);
    if (text) texts.set(text.turnId, text);
  }
  const turns = clean.filter((evt) => evt.event === 'chat_turn' && evt.turn_id !== null);
  const skips = await loadSpoolSkips(
    db,
    turns.map((evt) => evt.turn_id as string)
  );
  const rows = await Promise.all(
    turns.map((evt) =>
      scrubTurn(evt, texts.get(evt.turn_id as string), skips.get(evt.turn_id as string), env)
    )
  );
  return rows.filter((row): row is SpooledText => row !== null);
}

export type TailOverrides = {
  /** Wall clock for the PostHog queue stamp; tests pin it. */
  nowMs?: number;
};

export async function tailHandler(
  events: TraceItem[],
  env: Env,
  _ctx: ExecutionContext,
  overrides: TailOverrides = {}
): Promise<void> {
  const nowMs = overrides.nowMs ?? Date.now();
  const rawMessages = extractLogStrings(events);
  if (rawMessages.length === 0) return;
  const clean = await redactAll(rawMessages, env.PII_HASH_SALT);
  if (clean.length === 0) return;
  // Conversation text is scrubbed here, before anything touches D1, and only
  // the scrubbed text is spooled for the sender. A redelivered batch whose
  // turns D1 has already settled is skipped rather than re-scrubbed, and the
  // insert itself refuses a turn PostHog already has, so the spool cannot
  // outlive its turn. Anything nobody sends is swept after a day
  // (ingest/text.ts).
  const spool = await prepareConversationText(env.DB, clean, rawMessages, env);
  await spoolScrubbedText(env.DB, spool, nowMs);
  // D1 is the durable record. Chat turns are stamped for PostHog here and
  // sent by the once-a-minute cron once their session has settled.
  await ingestBatch(env.DB, clean, {
    sessionGapMs: sessionGapMs(env.SESSION_GAP_MINUTES),
    posthogQueuedAt: nowMs,
  });
}
