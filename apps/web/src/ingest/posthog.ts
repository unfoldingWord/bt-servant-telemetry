import { PostHog } from 'posthog-node';
import type { CleanEvent } from '@bt-servant-telemetry/shared';
import { EVENT_COLUMN_LIST, rowToCleanEvent, type EventRow } from './event-row.js';

/**
 * PostHog AI-observability emitter.
 *
 * Runs in the TAIL worker, not the engine, on purpose. The engine's Durable
 * Object processes the most common WhatsApp pattern (two messages sent in
 * quick succession) on its alarm path, where Cloudflare blocks outbound fetch
 * (error 1003). A PostHog client living in the engine would silently lose
 * exactly those turns. A tail worker is a separate invocation with no such
 * restriction — and it keeps the engine free of any vendor dependency.
 *
 * One `$ai_generation` per `chat_turn`. That single event serves BOTH PostHog
 * surfaces: AI observability reads the `$ai_*` fields for traces and cost, and
 * product analytics (trends, retention, lifecycle, cohorts) can filter on any
 * property. A second plain event per turn would double the identified-event
 * bill for no new information.
 *
 * No message text is sent. `$ai_input` / `$ai_output_choices` are deliberately
 * absent pending the content decision — and structurally absent too, since
 * `CleanEvent` never carried the text in the first place.
 *
 * Delivery is QUEUED, not inline. A turn's session_id / session_turn_index
 * can still change for a moment after it lands - a late or concurrent sibling
 * re-stitches it in D1 (sessions.ts) - and PostHog is append-only, so an
 * event sent from the ingesting invocation's own view could carry a session
 * D1 no longer agrees with. Instead tail ingest stamps `posthog_queued_at`,
 * and the flush below claims rows older than a settle window and emits them
 * with whatever session D1 holds by then. The settle window bounds delivery
 * disorder, not the session gap: a sibling arriving later than that can still
 * move an already-emitted turn in D1, and PostHog keeps the earlier value.
 */

export type PostHogEnv = {
  POSTHOG_API_KEY?: string;
  POSTHOG_HOST?: string;
  /** dev | production. One PostHog project receives both, so every event carries this. */
  ENVIRONMENT?: string;
  /** How long a queued turn waits before emission. Default 60. */
  POSTHOG_SETTLE_SECONDS?: string;
};

export const DEFAULT_POSTHOG_SETTLE_SECONDS = 60;

/** Parse the env var; fall back to the default on missing, NaN or negative. */
export function posthogSettleMs(raw: string | undefined): number {
  const seconds = Number(raw);
  const valid = Number.isFinite(seconds) && seconds >= 0;
  return (valid ? seconds : DEFAULT_POSTHOG_SETTLE_SECONDS) * 1000;
}

/** Turns claimed per flush. Bounds one invocation's work; the rest wait for the next. */
export const FLUSH_LIMIT = 200;

/**
 * How long a claim is honoured before another flush may take the row over.
 * Must outlast the slowest honest flush: posthog-node's shutdown() gives up
 * after 30s. Five minutes also matches the cron tick that drains stragglers.
 */
export const CLAIM_LEASE_MS = 5 * 60_000;

/** Anthropic reports these as `number | null`; PostHog wants numbers or nothing. */
function num(value: number | null): number | undefined {
  return value === null ? undefined : value;
}

/** Drop `undefined` and `null` so the event payload stays compact and typed. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/**
 * Map one turn to PostHog's `$ai_generation` shape.
 *
 * Required by PostHog for a valid generation: `$ai_trace_id`, `$ai_model`,
 * `$ai_provider`, `$ai_input_tokens`, `$ai_output_tokens`. `$ai_latency` is in
 * SECONDS (fractional), not milliseconds — the one unit trap in this mapping.
 *
 * `mode` is the mode that governed the turn and is the attribution key.
 * `mode_switched_to` is a NEXT-turn selection and must never be used for
 * attribution — it is included so the switch itself is observable.
 */
export function toGenerationProperties(evt: CleanEvent): Record<string, unknown> {
  return compact({
    // ── PostHog AI observability contract ──
    $ai_trace_id: evt.turn_id,
    // Groups consecutive turns into one conversation in the trace view.
    $ai_session_id: evt.session_id,
    session_turn_index: num(evt.session_turn_index),
    $ai_model: evt.model,
    $ai_provider: 'anthropic',
    $ai_input_tokens: num(evt.input_tokens),
    $ai_output_tokens: num(evt.output_tokens),
    $ai_cache_read_input_tokens: num(evt.cache_read_input_tokens),
    $ai_cache_creation_input_tokens: num(evt.cache_creation_input_tokens),
    $ai_latency: evt.duration_ms === null ? undefined : evt.duration_ms / 1000,
    // ── turn facts (bounded enums, ids, numbers — never text) ──
    turn_id: evt.turn_id,
    request_id: evt.request_id,
    org: evt.org,
    client_id: evt.client_id,
    transport: evt.transport,
    chat_type: evt.chat_type,
    mode: evt.mode,
    mode_switched_to: evt.mode_switched_to,
    language: evt.language,
    language_source: evt.language_source,
    response_language: evt.response_language,
    user_country: evt.user_country,
    edge_country: evt.edge_country,
    iterations: num(evt.iterations),
    exit_reason: evt.exit_reason,
    stop_reason: evt.stop_reason,
    mcp_calls_made: num(evt.mcp_calls_made),
    billable_input_tokens: num(evt.billable_input_tokens),
    had_inbound_voice: evt.had_inbound_voice,
    had_outbound_voice: evt.had_outbound_voice,
    // Person properties kept current on every turn; drives cohorts (Q9).
    $set: compact({ org: evt.org, client_id: evt.client_id }),
  });
}

/**
 * Build a client for ONE invocation. Never a module singleton: PostHog's
 * default batching is `setTimeout`-driven and does not fire reliably in
 * workerd, so we flush on every capture and drain explicitly at the end.
 * The `fetch` wrapper must be an arrow — posthog-node calls it as a method on
 * its options object, and the bare native function throws "Illegal invocation".
 */
function createClient(env: PostHogEnv): PostHog | null {
  if (!env.POSTHOG_API_KEY) return null;
  return new PostHog(env.POSTHOG_API_KEY, {
    host: env.POSTHOG_HOST ?? 'https://us.i.posthog.com',
    flushAt: 1,
    flushInterval: 0,
    disableGeoip: true, // would geolocate the Cloudflare colo, not the user
    fetch: (url, options) => fetch(url, options),
  });
}

/**
 * Atomically LEASE up to FLUSH_LIMIT settled, unsent turns: one statement, so
 * two invocations flushing at once get disjoint rows. A row is eligible when
 * it has settled and either nobody holds it or the holder's lease has
 * expired - a Worker that was terminated, timed out or crashed mid-flush
 * leaves its lease behind, and this is what gets those rows sent after all.
 * Rows come back with the session D1 holds NOW, which is the whole point.
 *
 * Binds: ?1 now, ?2 settle cutoff (queued at or before), ?3 lease cutoff
 * (claimed at or before = expired).
 */
const CLAIM_SETTLED = `
  UPDATE events SET posthog_claimed_at = ?1
   WHERE rowid IN (
     SELECT rowid FROM events
      WHERE posthog_queued_at IS NOT NULL AND posthog_emitted_at IS NULL
        AND posthog_queued_at <= ?2
        AND (posthog_claimed_at IS NULL OR posthog_claimed_at <= ?3)
        AND event = 'chat_turn' AND user_hash IS NOT NULL AND turn_id IS NOT NULL
      ORDER BY posthog_queued_at, ts
      LIMIT ${FLUSH_LIMIT})
   RETURNING ${EVENT_COLUMN_LIST}`;

/** Final marker, written only once PostHog has accepted the batch. */
const MARK_EMITTED = `UPDATE events SET posthog_emitted_at = ?1
  WHERE request_id = ?2 AND event = 'chat_turn' AND ts = ?3`;

/** Give a lease back early so the next flush retries without waiting it out. */
const RELEASE = `UPDATE events SET posthog_claimed_at = NULL
  WHERE request_id = ?1 AND event = 'chat_turn' AND ts = ?2`;

function warn(event: string, turns: number, error: unknown): void {
  console.warn(
    JSON.stringify({
      event,
      level: 'warn',
      turns,
      error: error instanceof Error ? error.message : String(error),
    })
  );
}

/**
 * Emit every settled, unsent turn as an `$ai_generation`. Called after each
 * tail ingest and from the five-minute cron, so a queue with no follow-on
 * traffic still drains.
 *
 * Fails OPEN with respect to ingest: D1 is the durable record and has already
 * been written. But delivery itself is at-least-once: a turn is marked
 * emitted only after PostHog accepts it; a send that fails is released at
 * once, and one whose invocation died is reclaimed when its lease expires.
 * `turn_id` as the event uuid makes the resulting duplicate sends - a crash
 * after acceptance but before the marker - idempotent in PostHog.
 *
 * Returns the number of turns handed to the client, for tests and logs.
 */
export async function flushQueuedTurns(
  db: D1Database,
  env: PostHogEnv,
  nowMs: number
): Promise<number> {
  const client = createClient(env);
  if (!client) return 0;

  const claimed = await db
    .prepare(CLAIM_SETTLED)
    .bind(nowMs, nowMs - posthogSettleMs(env.POSTHOG_SETTLE_SECONDS), nowMs - CLAIM_LEASE_MS)
    .all<EventRow>();
  const turns = claimed.results.map(rowToCleanEvent);
  if (turns.length === 0) return 0;

  // posthog-node reports transport failures on its emitter and then swallows
  // them inside shutdown(), so this is the only way to learn a send failed.
  let failure: unknown = null;
  client.on('error', (error: unknown) => {
    failure = error;
  });

  try {
    for (const evt of turns) {
      const properties = toGenerationProperties(evt);
      // Event-level, never $set: the same person can appear in both environments.
      if (env.ENVIRONMENT) properties.environment = env.ENVIRONMENT;
      client.capture({
        distinctId: evt.user_hash as string,
        event: '$ai_generation',
        properties,
        timestamp: new Date(evt.ts),
        // turn_id is a UUID minted per turn by the engine. Using it as the
        // event uuid makes a retried or replayed send idempotent in PostHog.
        uuid: evt.turn_id as string,
      });
    }
    await client.shutdown();
    if (failure !== null) throw failure;
    await db.batch(
      turns.map((evt) => db.prepare(MARK_EMITTED).bind(nowMs, evt.request_id, evt.ts))
    );
    return turns.length;
  } catch (error) {
    warn('posthog_emit_failed', turns.length, error);
    await db.batch(turns.map((evt) => db.prepare(RELEASE).bind(evt.request_id, evt.ts)));
    return 0;
  }
}
