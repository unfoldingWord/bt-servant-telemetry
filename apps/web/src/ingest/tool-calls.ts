import type { CleanEvent, ToolCallRecord } from '@bt-servant-telemetry/shared';

/**
 * Tool calls on a turn: parsing what the engine put on `chat_turn.tool_calls`,
 * and the two PostHog shapes built from it.
 *
 * The engine records each call as name, MCP server, start, duration and
 * outcome — never arguments or results, which can carry user text — so this
 * module needs no scrubbing and nothing here is ever withheld.
 *
 * Why two shapes: PostHog's Tools tab (and its "tool calls recorded" check)
 * reads tool calls out of a generation's OUTPUT, as Anthropic-style
 * `tool_use` content blocks. The trace tree and waterfall read `$ai_span`
 * events. One turn feeds both from the same list.
 */

/** Upper bound accepted per turn; mirrors the engine's own cap. */
export const MAX_TOOL_CALLS = 50;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

type ToolCallShape = { name: string; started_at: number; duration_ms: number; ok: boolean };

/** The engine's shape, checked field by field. Extra keys are ignored, never carried. */
function hasToolCallShape(
  o: Record<string, unknown>
): o is Record<string, unknown> & ToolCallShape {
  return (
    typeof o.name === 'string' &&
    o.name !== '' &&
    isFiniteNumber(o.started_at) &&
    isFiniteNumber(o.duration_ms) &&
    typeof o.ok === 'boolean'
  );
}

function asToolCall(item: unknown): ToolCallRecord | null {
  if (!item || typeof item !== 'object') return null;
  const o = item as Record<string, unknown>;
  if (!hasToolCallShape(o)) return null;
  return {
    name: o.name,
    server_id: typeof o.server_id === 'string' ? o.server_id : null,
    started_at: o.started_at,
    duration_ms: o.duration_ms,
    ok: o.ok,
  };
}

/**
 * The engine's `tool_calls` array, validated field by field. Unknown keys on
 * an item (an argument blob, say) are dropped rather than carried; a malformed
 * item is skipped; anything that is not an array at all is null.
 */
export function parseToolCalls(raw: unknown): ToolCallRecord[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ToolCallRecord[] = [];
  for (const item of raw.slice(0, MAX_TOOL_CALLS)) {
    const rec = asToolCall(item);
    if (rec) out.push(rec);
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Deterministic id for the i-th tool call of a turn: the turn's UUID with its
 * last four hex digits replaced by the index. Same turn, same index, same id —
 * so a resent batch is idempotent in PostHog, exactly like the generation whose
 * uuid is the turn_id itself. A turn_id that is not a UUID (never in production,
 * where the engine mints one) falls back to a random id.
 */
export function toolCallUuid(turnId: string, index: number): string {
  if (!UUID_RE.test(turnId)) return crypto.randomUUID();
  return `${turnId.slice(0, 32)}${index.toString(16).padStart(4, '0')}`;
}

/**
 * Anthropic-shaped `tool_use` blocks for the generation's assistant message.
 * Inputs are deliberately empty objects: PostHog needs only the names.
 */
export function toolUseBlocks(evt: CleanEvent): Array<Record<string, unknown>> {
  return (evt.tool_calls ?? []).map((call, i) => ({
    type: 'tool_use',
    id: toolCallUuid(evt.turn_id as string, i),
    name: call.name,
    input: {},
  }));
}

/** Tool names in call order, for plain product-analytics breakdowns. */
export function toolNames(evt: CleanEvent): string[] {
  return (evt.tool_calls ?? []).map((call) => call.name);
}
