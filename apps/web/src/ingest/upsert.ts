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

/** SQLite has no boolean type; store as 0/1 and preserve null. */
function boolToInt(value: boolean | null): number | null {
  return value === null ? null : value ? 1 : 0;
}

function utcDayKey(ts: number): number {
  const d = new Date(ts);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

/**
 * Positional bind values for the events INSERT.
 *
 * Extracted so the column list and the value list sit next to each other and
 * stay the same length — a transposed or missing value here writes the wrong
 * column with no error, which is the failure mode a wide INSERT invites.
 */
function eventBindValues(evt: CleanEvent): unknown[] {
  return [
    evt.request_id, evt.event, evt.ts, evt.level, evt.org, evt.user_hash, evt.client_id,
    evt.total_ms, evt.duration_ms, evt.chat_type, evt.transport, evt.tool_name, evt.server_id,
    evt.turn_id, evt.mode, evt.mode_switched_to, evt.language, evt.language_source,
    evt.response_language, evt.user_country, evt.edge_country, evt.model, evt.iterations,
    evt.exit_reason, evt.stop_reason, evt.mcp_calls_made, evt.input_tokens, evt.output_tokens,
    evt.cache_creation_input_tokens, evt.cache_read_input_tokens, evt.billable_input_tokens,
    boolToInt(evt.had_inbound_voice), boolToInt(evt.had_outbound_voice),
  ];
}

export async function upsertEvent(db: D1Database, evt: CleanEvent): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO events
        (request_id, event, ts, level, org, user_hash, client_id,
         total_ms, duration_ms, chat_type, transport, tool_name, server_id,
         turn_id, mode, mode_switched_to, language, language_source,
         response_language, user_country, edge_country, model, iterations,
         exit_reason, stop_reason, mcp_calls_made, input_tokens, output_tokens,
         cache_creation_input_tokens, cache_read_input_tokens,
         billable_input_tokens, had_inbound_voice, had_outbound_voice)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(...eventBindValues(evt))
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
