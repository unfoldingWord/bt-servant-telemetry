import { isKnownEvent, type CleanEvent, type TurnFacts } from '@bt-servant-telemetry/shared';

/**
 * The ingest boundary. Every log entry from bt-servant-worker passes through
 * `redact()` before reaching D1. This is a whitelist parser — only the named
 * fields below are extracted; anything else (response text, stack traces,
 * tool args, code bodies, CF runtime metadata) is dropped on the floor.
 *
 * The `user_id` field is hashed with HMAC-SHA-256 keyed by a server-side
 * secret salt and namespaced with `client_id` to prevent cross-channel
 * collisions. Raw user_id never leaves this module.
 */

export async function hashUserId(salt: string, clientId: string, userId: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(salt),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${clientId}:${userId}`));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function parseJsonObject(rawJson: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Pull the per-turn LLM facts off a `chat_turn` payload.
 *
 * Unconditional by design: `asString`/`asNumber`/`asBool` each return null when
 * the key is absent, so every other event type yields all-null turn facts
 * without a branch — and adding an event that happens to carry one of these
 * fields picks it up for free rather than silently dropping it.
 */
function extractTurnFacts(obj: Record<string, unknown>): TurnFacts {
  return {
    turn_id: asString(obj.turn_id),
    mode: asString(obj.mode),
    mode_switched_to: asString(obj.mode_switched_to),
    language: asString(obj.language),
    language_source: asString(obj.language_source),
    response_language: asString(obj.response_language),
    user_country: asString(obj.user_country),
    edge_country: asString(obj.edge_country),
    model: asString(obj.model),
    iterations: asNumber(obj.iterations),
    exit_reason: asString(obj.exit_reason),
    stop_reason: asString(obj.stop_reason),
    mcp_calls_made: asNumber(obj.mcp_calls_made),
    input_tokens: asNumber(obj.input_tokens),
    output_tokens: asNumber(obj.output_tokens),
    cache_creation_input_tokens: asNumber(obj.cache_creation_input_tokens),
    cache_read_input_tokens: asNumber(obj.cache_read_input_tokens),
    billable_input_tokens: asNumber(obj.billable_input_tokens),
    had_inbound_voice: asBool(obj.had_inbound_voice),
    had_outbound_voice: asBool(obj.had_outbound_voice),
    // Not on the wire. Derived during ingest by insertTurn() from prior turns.
    session_id: null,
    session_turn_index: null,
  };
}

export async function redact(rawJson: string, salt: string): Promise<CleanEvent | null> {
  const obj = parseJsonObject(rawJson);
  if (!obj) return null;

  const event = asString(obj.event);
  const requestId = asString(obj.request_id);
  const ts = asNumber(obj.timestamp);
  if (!event || !requestId || ts === null) return null;
  if (!isKnownEvent(event)) {
    // Schema-drift signal. Unknown event names mean bt-servant-worker shipped
    // a new event we haven't whitelisted yet. We emit a structured warning
    // (queryable via the Workers Observability Telemetry API as
    // event="telemetry_unknown_event_dropped") so the drift is observable
    // instead of disappearing silently.
    console.warn(
      JSON.stringify({
        event: 'telemetry_unknown_event_dropped',
        level: 'warn',
        unknown_event: event,
        request_id: requestId,
        timestamp: ts,
      })
    );
    return null;
  }

  const clientId = asString(obj.client_id);
  const userId = asString(obj.user_id);
  const userHash = clientId && userId ? await hashUserId(salt, clientId, userId) : null;

  return {
    event,
    ts,
    level: asString(obj.level),
    org: asString(obj.org),
    user_hash: userHash,
    client_id: clientId,
    request_id: requestId,
    total_ms: asNumber(obj.total_ms),
    duration_ms: asNumber(obj.duration_ms),
    chat_type: asString(obj.chat_type),
    transport: asString(obj.transport),
    tool_name: asString(obj.tool_name),
    server_id: asString(obj.server_id),
    first_interaction: asBool(obj.first_interaction),
    ...extractTurnFacts(obj),
  };
}
