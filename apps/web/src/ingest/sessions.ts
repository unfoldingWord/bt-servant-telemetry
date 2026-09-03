import type { CleanEvent } from '@bt-servant-telemetry/shared';
import {
  FACT_COLUMNS,
  FACT_COLUMN_LIST,
  FACT_PLACEHOLDERS,
  factPlaceholder,
  factValues,
} from './event-row.js';

/**
 * Conversation stitching for chat turns.
 *
 * The engine emits one `chat_turn` per message and has no conversation id to
 * give us: on WhatsApp the conversation IS the user's durable object. But this
 * worker has memory the engine lacks - D1 holds every prior turn. So each new
 * turn looks up the same user's chronologically previous turn: within the
 * inactivity gap it joins that turn's session, otherwise it starts a new one.
 *
 * A session is named after its first turn (`session_id = first turn_id`), which
 * keeps assignment deterministic under tail replays: a duplicate delivery of
 * the first turn re-derives the same id rather than minting a fresh one.
 *
 * Two properties the implementation has to hold, because tail delivery is
 * best-effort, unordered across batches, and not serialised per user:
 *
 * 1. Atomic assignment. The predecessor lookup and the row insert are ONE SQL
 *    statement (INSERT ... SELECT), so two concurrent invocations for the
 *    same user cannot both read the same predecessor and both take the same
 *    `session_turn_index`. D1 runs statements serially, so the second insert
 *    sees the first's row and numbers itself after it.
 *
 * 2. Chronological predecessor. The lookup is bounded by the incoming turn's
 *    own (ts, turn_id), never "the newest row we happen to hold". A late turn
 *    is therefore placed where it belongs in time; and because turns already
 *    stored AFTER it may have been assigned without knowing it existed, their
 *    sessions are recomputed from the late turn forward (one UPDATE over the
 *    user's chain). In-order delivery - the common path - never pays for the
 *    recompute: a cheap probe finds no successor and skips it.
 *
 * Known limitation: the recompute corrects D1 only. Successor turns already
 * forwarded to PostHog keep the session they were first given.
 *
 * The gap is per-env config (`SESSION_GAP_MINUTES`) because the right value for
 * WhatsApp - replies hours apart are still one conversation - is not the right
 * value for a web tab. Changing it affects turns going forward only.
 */

export const DEFAULT_SESSION_GAP_MINUTES = 30;

/** Parse the env var; fall back to the default on missing, NaN or non-positive. */
export function sessionGapMs(raw: string | undefined): number {
  const minutes = Number(raw);
  const valid = Number.isFinite(minutes) && minutes > 0;
  return (valid ? minutes : DEFAULT_SESSION_GAP_MINUTES) * 60_000;
}

/** A chat_turn we can place in a conversation: it has a user and a turn id. */
export function isStitchable(evt: CleanEvent): boolean {
  return evt.event === 'chat_turn' && evt.user_hash !== null && evt.turn_id !== null;
}

/**
 * Turns are totally ordered by (ts, turn_id) so equal timestamps still give
 * every turn exactly one predecessor. Legacy rows without a turn_id (pre-0003)
 * or without a session (pre-0004) cannot anchor a session and are skipped.
 */
const USER_TURNS = `user_hash = ?1 AND org IS ?2 AND event = 'chat_turn' AND turn_id IS NOT NULL`;

const P = {
  ts: factPlaceholder('ts'),
  org: factPlaceholder('org'),
  userHash: factPlaceholder('user_hash'),
  turnId: factPlaceholder('turn_id'),
  gap: `?${FACT_COLUMNS.length + 1}`,
};

/**
 * INSERT OR IGNORE the turn with its session derived in the same statement
 * from the chronologically previous stitched turn. `prev` is empty when there
 * is none; the CASE then starts a new session named after this turn.
 */
const INSERT_TURN = `
  WITH prev AS (
    SELECT ts, session_id, session_turn_index FROM events
     WHERE user_hash = ${P.userHash} AND org IS ${P.org} AND event = 'chat_turn'
       AND turn_id IS NOT NULL AND session_id IS NOT NULL
       AND (ts, turn_id) < (${P.ts}, ${P.turnId})
     ORDER BY ts DESC, turn_id DESC LIMIT 1
  )
  INSERT OR IGNORE INTO events (${FACT_COLUMN_LIST}, session_id, session_turn_index)
  SELECT ${FACT_PLACEHOLDERS},
    COALESCE((SELECT session_id FROM prev WHERE ${P.ts} - ts <= ${P.gap}), ${P.turnId}),
    COALESCE((SELECT session_turn_index + 1 FROM prev WHERE ${P.ts} - ts <= ${P.gap}), 1)`;

const READ_BACK = `SELECT session_id, session_turn_index FROM events
  WHERE request_id = ?1 AND event = 'chat_turn' AND ts = ?2`;

const HAS_SUCCESSOR = `SELECT 1 FROM events WHERE ${USER_TURNS} AND (ts, turn_id) > (?3, ?4) LIMIT 1`;

/**
 * Re-derive sessions for this user's turns from a given turn forward, treating
 * that turn's stored session as the anchor. A new session starts wherever the
 * silence since the previous turn exceeds the gap; each session is named after
 * its first turn and numbered 1..n. Only rows whose values change are written.
 *
 * Binds: ?1 user_hash, ?2 org, ?3 anchor ts, ?4 anchor turn_id, ?5 gap ms.
 */
const RECOMPUTE_FROM = `
  WITH chain AS (
    SELECT request_id, event, ts, turn_id, session_id, session_turn_index,
           CASE WHEN ts - LAG(ts) OVER (ORDER BY ts, turn_id) > ?5 THEN 1 ELSE 0 END AS starts
      FROM events
     WHERE ${USER_TURNS} AND (ts, turn_id) >= (?3, ?4)
  ),
  grouped AS (
    SELECT request_id, event, ts, turn_id, session_id, session_turn_index,
           SUM(starts) OVER (ORDER BY ts, turn_id ROWS UNBOUNDED PRECEDING) AS grp
      FROM chain
  ),
  assigned AS (
    SELECT request_id, event, ts,
           CASE WHEN grp = 0 THEN FIRST_VALUE(session_id) OVER whole
                ELSE FIRST_VALUE(turn_id) OVER by_session END AS new_session_id,
           CASE WHEN grp = 0 THEN FIRST_VALUE(session_turn_index) OVER whole - 1 ELSE 0 END
             + ROW_NUMBER() OVER by_session AS new_index
      FROM grouped
    WINDOW whole AS (ORDER BY ts, turn_id),
           by_session AS (PARTITION BY grp ORDER BY ts, turn_id)
  )
  UPDATE events
     SET session_id = assigned.new_session_id, session_turn_index = assigned.new_index
    FROM assigned
   WHERE events.request_id = assigned.request_id
     AND events.event = assigned.event
     AND events.ts = assigned.ts
     AND (events.session_id IS NOT assigned.new_session_id
          OR events.session_turn_index IS NOT assigned.new_index)`;

type SessionRow = { session_id: string | null; session_turn_index: number | null };

/**
 * Insert a stitchable chat_turn into D1 with its session assigned, then copy
 * the stored `session_id` / `session_turn_index` back onto the CleanEvent so
 * the same object carries them on to PostHog. A replayed turn is ignored by
 * the insert and simply reads back what it was given the first time.
 */
export async function insertTurn(db: D1Database, evt: CleanEvent, gapMs: number): Promise<void> {
  const inserted = await db
    .prepare(INSERT_TURN)
    .bind(...factValues(evt), gapMs)
    .run();

  const row = await db.prepare(READ_BACK).bind(evt.request_id, evt.ts).first<SessionRow>();
  evt.session_id = row?.session_id ?? null;
  evt.session_turn_index = row?.session_turn_index ?? null;

  // Only a NEW row can invalidate turns stored after it; a replay changes nothing.
  if (inserted.meta.changes === 0) return;
  const userTurn = [evt.user_hash, evt.org, evt.ts, evt.turn_id];
  const successor = await db
    .prepare(HAS_SUCCESSOR)
    .bind(...userTurn)
    .first();
  if (!successor) return;
  await db
    .prepare(RECOMPUTE_FROM)
    .bind(...userTurn, gapMs)
    .run();
}
