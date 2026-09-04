import type { CleanEvent } from '@bt-servant-telemetry/shared';
import { parseJsonObject } from './redact.js';

/**
 * Conversation text: extraction off the raw chat_turn line, the per-turn
 * `text_status` vocabulary, and the short-lived spool that carries SCRUBBED
 * text from tail ingest to the PostHog sender (ingest/posthog.ts).
 *
 * The spool exists because delivery is queued: the sender runs a minute later
 * from a cron and reads turns back out of D1, so the text has to wait
 * somewhere. It waits here, already scrubbed (ingest/scrub.ts), and is deleted
 * the moment PostHog accepts the turn — plus a daily sweep for anything that
 * never got sent. `CleanEvent` never carries text, so the events table cannot.
 */

export const TEXT_STATUS = {
  /** The record carried no text fields (an engine older than the text change). */
  off: 'off',
  /** Scrubbed and spooled; the sender attaches it to the $ai_generation. */
  scrubbed: 'scrubbed',
  /** Text fields present but both blank (e.g. an attachment-only message). */
  empty: 'empty',
  /** No ANTHROPIC_API_KEY on this worker, so nothing could be scrubbed. Text dropped. */
  unavailable: 'scrub_unavailable',
  /** The scrubber errored or answered implausibly. Text dropped. */
  failed: 'scrub_failed',
} as const;
export type TextStatus = (typeof TEXT_STATUS)[keyof typeof TEXT_STATUS];

export type ConversationText = { turnId: string; userMessage: string; assistantReply: string };

/**
 * The two text fields off a raw `chat_turn` line, or null when the record
 * carries none (an older engine) or is not a chat_turn at all.
 */
export function extractConversationText(rawJson: string): ConversationText | null {
  const obj = parseJsonObject(rawJson);
  if (!obj || obj.event !== 'chat_turn' || typeof obj.turn_id !== 'string') return null;
  const { user_message, assistant_reply } = obj;
  if (typeof user_message !== 'string' || typeof assistant_reply !== 'string') return null;
  return { turnId: obj.turn_id, userMessage: user_message, assistantReply: assistant_reply };
}

/** Structured warning for a turn whose text was withheld. Carries the reason, never the text. */
export function warnTextDropped(evt: CleanEvent, status: TextStatus, detail?: string): void {
  console.warn(
    JSON.stringify({
      event: 'conversation_text_dropped',
      level: 'warn',
      turn_id: evt.turn_id,
      request_id: evt.request_id,
      text_status: status,
      ...(detail === undefined ? {} : { detail }),
    })
  );
}

// ── Spool ─────────────────────────────────────────────────────────────────────

/** One spooled row: scrubbed text keyed by the turn it belongs to. */
export type SpooledText = { turn_id: string; user_message: string; assistant_reply: string };

const INSERT_TEXT = `INSERT OR REPLACE INTO turn_text (turn_id, user_message, assistant_reply, created_at)
  VALUES (?1, ?2, ?3, ?4)`;

/** Write scrubbed text for the sender to pick up. No-op for an empty batch. */
export async function spoolScrubbedText(
  db: D1Database,
  rows: SpooledText[],
  nowMs: number
): Promise<void> {
  if (rows.length === 0) return;
  await db.batch(
    rows.map((r) =>
      db.prepare(INSERT_TEXT).bind(r.turn_id, r.user_message, r.assistant_reply, nowMs)
    )
  );
}

/** D1 caps bound parameters per statement; keep IN lists well under it. */
const IN_CHUNK = 50;

/** Spooled text for the given turns, keyed by turn_id. Turns without text are simply absent. */
export async function loadSpooledText(
  db: D1Database,
  turnIds: string[]
): Promise<Map<string, SpooledText>> {
  const out = new Map<string, SpooledText>();
  for (let i = 0; i < turnIds.length; i += IN_CHUNK) {
    const chunk = turnIds.slice(i, i + IN_CHUNK);
    const placeholders = chunk.map((_, j) => `?${j + 1}`).join(', ');
    const { results } = await db
      .prepare(
        `SELECT turn_id, user_message, assistant_reply FROM turn_text WHERE turn_id IN (${placeholders})`
      )
      .bind(...chunk)
      .all<SpooledText>();
    for (const row of results) out.set(row.turn_id, row);
  }
  return out;
}

/** Forget a turn's text once PostHog has it. Binds: ?1 turn_id. */
export const DELETE_TEXT = `DELETE FROM turn_text WHERE turn_id = ?1`;

/** Text that never got sent (turn never settled, sender down) is dropped after a day. */
export const TEXT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Binds: ?1 cutoff (ms epoch); rows created before it go. */
export const SWEEP_STALE_TEXT = `DELETE FROM turn_text WHERE created_at < ?1`;
