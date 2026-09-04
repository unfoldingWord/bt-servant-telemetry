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
 * Spool a turn's text ONLY on the delivery that first stores the turn.
 *
 * The guard is what makes the table a queue rather than a leak. Tail
 * deliveries are replayable and the events insert is `INSERT OR IGNORE`, so a
 * redelivery cannot change the stored turn's `text_status` — which means the
 * status it already carries is the final word on that turn's text, and a
 * second spool row could only contradict it: attaching `$ai_input` to a turn
 * that says `spool_expired`, or reviving a conversation the retention sweep
 * has already dropped for another day. An existing event row of any kind is
 * therefore a stop sign. A turn with none — the normal case, since the spool
 * is written before ingest — passes.
 */
const INSERT_TEXT = `INSERT OR REPLACE INTO turn_text (turn_id, user_message, assistant_reply, created_at)
  SELECT ?1, ?2, ?3, ?4
   WHERE NOT EXISTS (
     SELECT 1 FROM events WHERE turn_id = ?1 AND event = 'chat_turn'
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
 * D1's standing answer for one turn. Wrapped rather than bare so that "no
 * decision" (absent from the map) cannot be confused with a decision of null —
 * a chat_turn stored before this feature shipped.
 */
export type SettledText = { status: TextStatus | null };

/**
 * The text decision D1 already holds for each of these turns, keyed by
 * turn_id. A turn absent from the map has never been here.
 *
 * A turn's text is decided ONCE, on the delivery that stores it. Cloudflare
 * can redeliver a tail batch, and the events insert is `INSERT OR IGNORE`, so
 * a later pass cannot change the stored `text_status` — only contradict it.
 * Reprocessing would also pay Anthropic a second time for the same words, and,
 * after the retention sweep has expired a turn, would put that conversation
 * back in D1 for another day. So the stored decision wins, whatever it says,
 * and this is the one indexed lookup per batch that surfaces it.
 *
 * Two places hold a decision, and they are checked together because either can
 * exist without the other: the `events` row is authoritative, and a spool row
 * with no event row is the delivery that spooled and then died before ingest —
 * its text is already scrubbed and waiting, so that turn is settled too.
 */
export async function loadSettledText(
  db: D1Database,
  turnIds: string[]
): Promise<Map<string, SettledText>> {
  const out = new Map<string, SettledText>();
  for (let i = 0; i < turnIds.length; i += IN_CHUNK) {
    const chunk = turnIds.slice(i, i + IN_CHUNK);
    const placeholders = chunk.map((_, j) => `?${j + 1}`).join(', ');
    const { results } = await db
      .prepare(
        `SELECT turn_id, text_status AS status, 1 AS stored FROM events
          WHERE event = 'chat_turn' AND turn_id IN (${placeholders})
         UNION ALL
         SELECT turn_id, '${TEXT_STATUS.scrubbed}' AS status, 0 AS stored FROM turn_text
          WHERE turn_id IN (${placeholders})`
      )
      .bind(...chunk)
      .all<{ turn_id: string; status: TextStatus | null; stored: number }>();
    // The events row wins wherever both exist; apply it last, not by row order.
    for (const row of [...results].sort((a, b) => a.stored - b.stored)) {
      out.set(row.turn_id, { status: row.status });
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
