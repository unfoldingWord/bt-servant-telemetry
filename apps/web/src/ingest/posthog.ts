import { PostHog } from 'posthog-node';
import type { CleanEvent } from '@bt-servant-telemetry/shared';
import { EVENT_COLUMN_LIST, rowToCleanEvent, type EventRow } from './event-row.js';
import {
  DELETE_TEXT,
  SWEEP_STALE_TEXT,
  TEXT_MAX_AGE_MS,
  loadSpooledText,
  type SpooledText,
} from './text.js';

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
 * Message text travels separately from the turn facts. Tail ingest scrubs
 * personal names and contact details out of the user's message and the
 * assistant's reply (ingest/scrub.ts) and spools ONLY the scrubbed text
 * (ingest/text.ts). The
 * sender attaches it as `$ai_input` / `$ai_output_choices` and deletes the
 * spooled row once PostHog accepts the turn. `CleanEvent` never carries text,
 * so the events table cannot; `text_status` records why a turn has or lacks it.
 *
 * Delivery is QUEUED, not inline. A turn's session_id / session_turn_index
 * can still change for a moment after it lands - a late or concurrent sibling
 * re-stitches it in D1 (sessions.ts) - and PostHog is append-only, so an
 * event sent from the ingesting invocation's own view could carry a session
 * D1 no longer agrees with. Instead tail ingest stamps `posthog_queued_at`,
 * and a once-a-minute cron (the ONLY sender) emits rows older than a settle
 * window with whatever session D1 holds by then. The settle window bounds
 * delivery disorder, not the session gap: a sibling arriving later than that
 * can still move an already-emitted turn in D1, and PostHog keeps the
 * earlier value.
 *
 * One sender means no claim or lease is needed: ticks do not overlap, and a
 * tick that dies mid-send simply leaves its rows unmarked for the next one.
 * `turn_id` as the event uuid makes the resulting resend idempotent.
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

/** Turns sent per tick. Bounds one invocation's work; the rest wait for the next. */
export const FLUSH_LIMIT = 200;

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

/** PostHog's conversation shape for the one exchange this turn is. */
function conversationProperties(text: SpooledText | undefined): Record<string, unknown> {
  if (!text) return {};
  return {
    $ai_input: [{ role: 'user', content: text.user_message }],
    $ai_output_choices: [{ role: 'assistant', content: text.assistant_reply }],
  };
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
 *
 * `text`, when spooled for this turn, is the SCRUBBED conversation; it is the
 * only free text that ever appears on the event.
 */
export function toGenerationProperties(
  evt: CleanEvent,
  text?: SpooledText
): Record<string, unknown> {
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
    // Why this turn does or does not carry conversation text (ingest/text.ts).
    text_status: evt.text_status,
    // ── conversation text (scrubbed at ingest; present only when spooled) ──
    ...conversationProperties(text),
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
 * The oldest FLUSH_LIMIT settled, unsent turns, with the session D1 holds NOW
 * - which is the whole point. Binds: ?1 settle cutoff (queued at or before).
 */
const SELECT_SETTLED = `
  SELECT ${EVENT_COLUMN_LIST} FROM events
   WHERE posthog_queued_at IS NOT NULL AND posthog_emitted_at IS NULL
     AND posthog_queued_at <= ?1
     AND event = 'chat_turn' AND user_hash IS NOT NULL AND turn_id IS NOT NULL
   ORDER BY posthog_queued_at, ts
   LIMIT ${FLUSH_LIMIT}`;

/** Final marker, written only once PostHog has accepted the batch. */
const MARK_EMITTED = `UPDATE events SET posthog_emitted_at = ?1
  WHERE request_id = ?2 AND event = 'chat_turn' AND ts = ?3`;

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

/** Capture every turn and drain the client; throws if PostHog rejected the batch. */
async function sendGenerations(
  client: PostHog,
  turns: CleanEvent[],
  texts: Map<string, SpooledText>,
  env: PostHogEnv
): Promise<void> {
  // posthog-node reports transport failures on its emitter and then swallows
  // them inside shutdown(), so this is the only way to learn a send failed.
  let failure: unknown = null;
  client.on('error', (error: unknown) => {
    failure = error;
  });
  for (const evt of turns) {
    const properties = toGenerationProperties(evt, texts.get(evt.turn_id as string));
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
}

/**
 * Emit every settled, unsent turn as an `$ai_generation`. Runs from the
 * once-a-minute cron and nowhere else.
 *
 * Fails OPEN with respect to ingest: D1 is the durable record and was written
 * by the tail handler long before this runs. Delivery itself is at-least-once:
 * a turn is marked emitted only after PostHog accepts it, so a tick that
 * fails or dies leaves its rows for the next tick, and `turn_id` as the event
 * uuid makes the resend idempotent in PostHog.
 *
 * Spooled conversation text rides along with its turn and is deleted in the
 * same batch that marks the turn emitted. Text that never gets sent is swept
 * after a day on every tick — before the key check, on purpose, so spooled
 * text cannot outlive a day even on a worker that is not sending to PostHog.
 *
 * Returns the number of turns handed to the client, for tests and logs.
 */
export async function flushQueuedTurns(
  db: D1Database,
  env: PostHogEnv,
  nowMs: number
): Promise<number> {
  await db
    .prepare(SWEEP_STALE_TEXT)
    .bind(nowMs - TEXT_MAX_AGE_MS)
    .run();
  const client = createClient(env);
  if (!client) return 0;

  const settled = await db
    .prepare(SELECT_SETTLED)
    .bind(nowMs - posthogSettleMs(env.POSTHOG_SETTLE_SECONDS))
    .all<EventRow>();
  const turns = settled.results.map(rowToCleanEvent);
  if (turns.length === 0) return 0;
  const texts = await loadSpooledText(
    db,
    turns.map((evt) => evt.turn_id as string)
  );

  try {
    await sendGenerations(client, turns, texts, env);
    await db.batch([
      ...turns.map((evt) => db.prepare(MARK_EMITTED).bind(nowMs, evt.request_id, evt.ts)),
      ...turns.map((evt) => db.prepare(DELETE_TEXT).bind(evt.turn_id)),
    ]);
    return turns.length;
  } catch (error) {
    warn('posthog_emit_failed', turns.length, error);
    return 0; // nothing marked, nothing deleted: the next tick sends these again
  }
}
