import type { CleanEvent } from '@bt-servant-telemetry/shared';

/**
 * D1 writes for a CleanEvent batch. All writes are idempotent and
 * order-independent so backfill replays and out-of-order tail delivery
 * both produce the same final state:
 *
 * - events: INSERT OR IGNORE on PK (request_id, event, ts).
 * - user_active_days: INSERT OR IGNORE on PK (user_hash, org, day) — the
 *   source of truth for distinct-day counts.
 * - users: days_active_count is recomputed from user_active_days on every
 *   upsert (subquery); first_interaction_transition_ts is set to the
 *   minimum of the stored and incoming values rather than whichever
 *   arrived first.
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
    .prepare(`INSERT OR IGNORE INTO user_active_days (user_hash, org, day) VALUES (?, ?, ?)`)
    .bind(evt.user_hash, evt.org, day)
    .run();

  await db
    .prepare(
      `INSERT INTO users
        (user_hash, org, client_id, first_seen_ts, last_seen_ts,
         days_active_count, last_active_day, first_interaction_transition_ts)
       VALUES (
         ?, ?, ?, ?, ?,
         (SELECT COUNT(*) FROM user_active_days WHERE user_hash = ? AND org = ?),
         ?, ?
       )
       ON CONFLICT (user_hash, org) DO UPDATE SET
         last_seen_ts = MAX(users.last_seen_ts, excluded.last_seen_ts),
         first_seen_ts = MIN(users.first_seen_ts, excluded.first_seen_ts),
         days_active_count = (
           SELECT COUNT(*) FROM user_active_days
           WHERE user_hash = users.user_hash AND org = users.org
         ),
         last_active_day = MAX(users.last_active_day, excluded.last_active_day),
         first_interaction_transition_ts = COALESCE(
           MIN(users.first_interaction_transition_ts, excluded.first_interaction_transition_ts),
           users.first_interaction_transition_ts,
           excluded.first_interaction_transition_ts
         )`
    )
    .bind(
      evt.user_hash,
      evt.org,
      evt.client_id,
      evt.ts,
      evt.ts,
      evt.user_hash,
      evt.org,
      day,
      firstInteractionTs
    )
    .run();
}

export async function ingestBatch(db: D1Database, events: CleanEvent[]): Promise<void> {
  for (const evt of events) {
    await upsertEvent(db, evt);
    await upsertUser(db, evt);
  }
}
