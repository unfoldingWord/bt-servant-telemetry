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
  /**
   * Scrubbed text was spooled but nobody sent it within a day, so the sweep
   * dropped it. The turn still goes to PostHog, without text — this is what
   * keeps it from claiming `scrubbed` when the words are already gone.
   */
  spoolExpired: 'spool_expired',
  /**
   * A redelivered tail batch whose turn PostHog already has. Its text was
   * settled the first time round; re-scrubbing would buy a second Anthropic
   * call and a spooled row no sender would ever collect.
   */
  alreadyEmitted: 'already_emitted',
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

/**
 * Spool a turn's text ONLY while that turn is still owed to PostHog.
 *
 * The guard is what makes the table a queue rather than a leak. Tail
 * deliveries are replayable and the events insert is `INSERT OR IGNORE`, so a
 * batch can arrive whose turn was emitted (and whose text deleted) minutes
 * ago; without the `NOT EXISTS` an insert here would create a row no sender
 * can ever select, and it would sit in D1 until the daily sweep. A turn with
 * no event row yet — the normal case, since the spool is written before
 * ingest — has nothing emitted and so passes.
 */
const INSERT_TEXT = `INSERT OR REPLACE INTO turn_text (turn_id, user_message, assistant_reply, created_at)
  SELECT ?1, ?2, ?3, ?4
   WHERE NOT EXISTS (
     SELECT 1 FROM events
      WHERE turn_id = ?1 AND event = 'chat_turn' AND posthog_emitted_at IS NOT NULL
   )`;

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

/**
 * Why a turn in an incoming batch needs no scrubbing:
 *   emitted  PostHog already has the turn; its text is settled and deleted.
 *   spooled  scrubbed text is already waiting for the sender.
 */
export type SpoolSkip = 'emitted' | 'spooled';

/**
 * Which of these turns tail ingest must NOT scrub again, and why.
 *
 * Cloudflare can redeliver a tail batch, and both destinations are idempotent
 * by design (`INSERT OR IGNORE` on events, `turn_id` as the PostHog event
 * uuid) — but the scrubber is not: a second pass is a second Anthropic call on
 * the same words. Worse, spooling after emission writes a row the sender will
 * never look at again. One indexed lookup per batch closes both.
 */
export async function loadSpoolSkips(
  db: D1Database,
  turnIds: string[]
): Promise<Map<string, SpoolSkip>> {
  const out = new Map<string, SpoolSkip>();
  for (let i = 0; i < turnIds.length; i += IN_CHUNK) {
    const chunk = turnIds.slice(i, i + IN_CHUNK);
    const placeholders = chunk.map((_, j) => `?${j + 1}`).join(', ');
    const { results } = await db
      .prepare(
        `SELECT turn_id, 'emitted' AS reason FROM events
          WHERE event = 'chat_turn' AND posthog_emitted_at IS NOT NULL
            AND turn_id IN (${placeholders})
         UNION ALL
         SELECT turn_id, 'spooled' AS reason FROM turn_text
          WHERE turn_id IN (${placeholders})`
      )
      .bind(...chunk)
      .all<{ turn_id: string; reason: SpoolSkip }>();
    // 'emitted' wins: it is the row that must not be re-created.
    for (const row of results) {
      if (row.reason === 'emitted' || !out.has(row.turn_id)) out.set(row.turn_id, row.reason);
    }
  }
  return out;
}

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

/**
 * Re-label the turns the sweep is about to strip. Binds: ?1 the same cutoff.
 *
 * Only turns still owed to PostHog matter: an emitted turn's `scrubbed` is a
 * true account of what was sent. A pending one, though, would otherwise arrive
 * later with no `$ai_input` while still claiming `scrubbed` — text_status is
 * meant to explain every absence, so expiry gets its own value.
 */
export const MARK_EXPIRED_TEXT = `UPDATE events
     SET text_status = '${TEXT_STATUS.spoolExpired}'
   WHERE event = 'chat_turn'
     AND posthog_emitted_at IS NULL
     AND text_status = '${TEXT_STATUS.scrubbed}'
     AND turn_id IN (SELECT turn_id FROM turn_text WHERE created_at < ?1)`;

/**
 * Drop day-old spooled text, re-labelling its still-pending turns first. The
 * two run in one D1 batch — a single transaction — so no turn can be left
 * saying `scrubbed` with its words already deleted.
 */
export async function sweepExpiredText(db: D1Database, nowMs: number): Promise<void> {
  const cutoff = nowMs - TEXT_MAX_AGE_MS;
  await db.batch([
    db.prepare(MARK_EXPIRED_TEXT).bind(cutoff),
    db.prepare(SWEEP_STALE_TEXT).bind(cutoff),
  ]);
}
