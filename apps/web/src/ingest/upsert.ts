import type { CleanEvent } from '@bt-servant-telemetry/shared';

/**
 * D1 writes for a CleanEvent batch. All writes are idempotent so backfill
 * replays are safe:
 * - events: INSERT OR IGNORE on PK (request_id, event, ts)
 * - users: UPSERT extending first_seen_ts/last_seen_ts/days_active_count
 *   based on whether last_active_day changed.
 *
 * Caller is responsible for ensuring CleanEvents have already been through
 * `redact()` — there is no PII check here.
 */

function utcDayKey(ts: number): number {
  const d = new Date(ts);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

export async function upsertEvent(db: D1Database, evt: CleanEvent): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO events
        (request_id, event, ts, level, org, user_hash, client_id,
         total_ms, duration_ms, chat_type, transport, tool_name, server_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      evt.request_id,
      evt.event,
      evt.ts,
      evt.level,
      evt.org,
      evt.user_hash,
      evt.client_id,
      evt.total_ms,
      evt.duration_ms,
      evt.chat_type,
      evt.transport,
      evt.tool_name,
      evt.server_id
    )
    .run();
}

export async function upsertUser(db: D1Database, evt: CleanEvent): Promise<void> {
  if (!evt.user_hash || !evt.org || !evt.client_id) return;

  const day = utcDayKey(evt.ts);
  const firstInteractionTs = evt.first_interaction === true ? evt.ts : null;

  await db
    .prepare(
      `INSERT INTO users
        (user_hash, org, client_id, first_seen_ts, last_seen_ts,
         days_active_count, last_active_day, first_interaction_transition_ts)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (user_hash, org) DO UPDATE SET
         last_seen_ts = MAX(users.last_seen_ts, excluded.last_seen_ts),
         first_seen_ts = MIN(users.first_seen_ts, excluded.first_seen_ts),
         days_active_count = users.days_active_count
           + (CASE WHEN excluded.last_active_day > users.last_active_day THEN 1 ELSE 0 END),
         last_active_day = MAX(users.last_active_day, excluded.last_active_day),
         first_interaction_transition_ts =
           COALESCE(users.first_interaction_transition_ts, excluded.first_interaction_transition_ts)`
    )
    .bind(evt.user_hash, evt.org, evt.client_id, evt.ts, evt.ts, day, firstInteractionTs)
    .run();
}

export async function ingestBatch(db: D1Database, events: CleanEvent[]): Promise<void> {
  for (const evt of events) {
    await upsertEvent(db, evt);
    await upsertUser(db, evt);
  }
}
