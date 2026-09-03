import type { CleanEvent } from '@bt-servant-telemetry/shared';

/**
 * Conversation stitching for chat turns.
 *
 * The engine emits one `chat_turn` per message and has no conversation id to
 * give us: on WhatsApp the conversation IS the user's durable object. But this
 * worker has memory the engine lacks - D1 holds every prior turn. So each new
 * turn looks up the same user's previous turn: within the inactivity gap it
 * joins that turn's session, otherwise it starts a new one.
 *
 * A session is named after its first turn (`session_id = first turn_id`), which
 * keeps assignment deterministic under tail replays: a duplicate delivery of
 * the first turn re-derives the same id rather than minting a fresh one.
 *
 * Known approximation: tail delivery is best-effort and can be out of order
 * across batches. A late-arriving older turn joins the newer turn's session
 * (the gap test is symmetric), so the PERSON is always right and only the
 * session boundary can occasionally blur. Within a batch, ingest sorts by ts.
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

type PrevTurn = { ts: number; session_id: string | null; session_turn_index: number | null };

/** Most recent OTHER chat_turn by this user in this org, if any. Uses events_user_idx. */
async function previousTurn(db: D1Database, evt: CleanEvent): Promise<PrevTurn | null> {
  return db
    .prepare(
      `SELECT ts, session_id, session_turn_index FROM events
        WHERE user_hash = ?1 AND org IS ?2 AND event = 'chat_turn' AND turn_id IS NOT ?3
        ORDER BY ts DESC LIMIT 1`
    )
    .bind(evt.user_hash, evt.org, evt.turn_id)
    .first<PrevTurn>();
}

/**
 * Assign `session_id` and `session_turn_index` to a chat_turn, in place, so the
 * same object carries them into both the D1 row and the PostHog event.
 * Non-chat_turn events and turns without an identity are left untouched.
 */
export async function assignSession(
  db: D1Database,
  evt: CleanEvent,
  gapMs: number
): Promise<void> {
  if (evt.event !== 'chat_turn' || !evt.user_hash || !evt.turn_id) return;
  const prev = await previousTurn(db, evt);
  const continues = prev !== null && prev.session_id !== null && Math.abs(evt.ts - prev.ts) <= gapMs;
  if (continues) {
    evt.session_id = prev.session_id;
    evt.session_turn_index = (prev.session_turn_index ?? 0) + 1;
  } else {
    evt.session_id = evt.turn_id;
    evt.session_turn_index = 1;
  }
}
