import { PostHog } from 'posthog-node';
import type { CleanEvent } from '@bt-servant-telemetry/shared';

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
 */

export type PostHogEnv = {
  POSTHOG_API_KEY?: string;
  POSTHOG_HOST?: string;
};

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

/** A turn we can emit: it is a chat_turn AND it carries the two ids PostHog needs. */
function isEmittableTurn(evt: CleanEvent): boolean {
  return evt.event === 'chat_turn' && evt.user_hash !== null && evt.turn_id !== null;
}

/**
 * Build a client for ONE tail invocation. Never a module singleton: PostHog's
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
 * Emit every emittable turn in the batch. Fails OPEN: a PostHog problem must
 * never break D1 ingest, which is the durable record and runs before this.
 * Failures are logged as structured JSON so they are queryable in Workers
 * Observability, matching the ingest boundary's own `telemetry_*` warnings.
 *
 * Returns the number of turns handed to the client, for tests and logs.
 */
export async function emitTurnsToPostHog(
  clean: CleanEvent[],
  env: PostHogEnv,
  ctx: ExecutionContext
): Promise<number> {
  const turns = clean.filter(isEmittableTurn);
  if (turns.length === 0) return 0;
  const client = createClient(env);
  if (!client) return 0;

  try {
    for (const evt of turns) {
      client.capture({
        distinctId: evt.user_hash as string,
        event: '$ai_generation',
        properties: toGenerationProperties(evt),
        timestamp: new Date(evt.ts),
        // turn_id is a UUID minted per turn by the engine. Using it as the
        // event uuid makes replayed tail deliveries idempotent in PostHog.
        uuid: evt.turn_id as string,
      });
    }
    ctx.waitUntil(
      client.shutdown().catch((error: unknown) => {
        console.warn(
          JSON.stringify({
            event: 'posthog_flush_failed',
            level: 'warn',
            turns: turns.length,
            error: error instanceof Error ? error.message : String(error),
          })
        );
      })
    );
    return turns.length;
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'posthog_emit_failed',
        level: 'warn',
        turns: turns.length,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return 0;
  }
}
