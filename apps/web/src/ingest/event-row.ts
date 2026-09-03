import type { CleanEvent } from '@bt-servant-telemetry/shared';

/**
 * The `events` table's fact columns - everything except the two derived
 * session columns - as one ordered list that both INSERT paths (plain events
 * in upsert.ts, stitched chat turns in sessions.ts) share.
 *
 * Values are produced from a keyed record so a column can never be silently
 * transposed against its value: a wide positional INSERT writes the wrong
 * column with no error, and this closes that failure mode at the type level.
 */
export const FACT_COLUMNS = [
  'request_id',
  'event',
  'ts',
  'level',
  'org',
  'user_hash',
  'client_id',
  'total_ms',
  'duration_ms',
  'chat_type',
  'transport',
  'tool_name',
  'server_id',
  'turn_id',
  'mode',
  'mode_switched_to',
  'language',
  'language_source',
  'response_language',
  'user_country',
  'edge_country',
  'model',
  'iterations',
  'exit_reason',
  'stop_reason',
  'mcp_calls_made',
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'billable_input_tokens',
  'had_inbound_voice',
  'had_outbound_voice',
] as const;

export type FactColumn = (typeof FACT_COLUMNS)[number];

/** SQLite has no boolean type; store as 0/1 and preserve null. */
function boolToInt(value: boolean | null): number | null {
  return value === null ? null : value ? 1 : 0;
}

function factRecord(evt: CleanEvent): Record<FactColumn, unknown> {
  return {
    request_id: evt.request_id,
    event: evt.event,
    ts: evt.ts,
    level: evt.level,
    org: evt.org,
    user_hash: evt.user_hash,
    client_id: evt.client_id,
    total_ms: evt.total_ms,
    duration_ms: evt.duration_ms,
    chat_type: evt.chat_type,
    transport: evt.transport,
    tool_name: evt.tool_name,
    server_id: evt.server_id,
    turn_id: evt.turn_id,
    mode: evt.mode,
    mode_switched_to: evt.mode_switched_to,
    language: evt.language,
    language_source: evt.language_source,
    response_language: evt.response_language,
    user_country: evt.user_country,
    edge_country: evt.edge_country,
    model: evt.model,
    iterations: evt.iterations,
    exit_reason: evt.exit_reason,
    stop_reason: evt.stop_reason,
    mcp_calls_made: evt.mcp_calls_made,
    input_tokens: evt.input_tokens,
    output_tokens: evt.output_tokens,
    cache_creation_input_tokens: evt.cache_creation_input_tokens,
    cache_read_input_tokens: evt.cache_read_input_tokens,
    billable_input_tokens: evt.billable_input_tokens,
    had_inbound_voice: boolToInt(evt.had_inbound_voice),
    had_outbound_voice: boolToInt(evt.had_outbound_voice),
  };
}

/** Bind values in FACT_COLUMNS order. */
export function factValues(evt: CleanEvent): unknown[] {
  const record = factRecord(evt);
  // `col` ranges over the const tuple above, never over caller input.
  // eslint-disable-next-line security/detect-object-injection
  return FACT_COLUMNS.map((col) => record[col]);
}

/** Comma-separated column list for an INSERT. */
export const FACT_COLUMN_LIST = FACT_COLUMNS.join(', ');

/** `?1, ?2, ...` - one numbered placeholder per fact column, in order. */
export const FACT_PLACEHOLDERS = FACT_COLUMNS.map((_, i) => `?${i + 1}`).join(', ');

/** The numbered placeholder that carries a given fact column's value. */
export function factPlaceholder(col: FactColumn): string {
  return `?${FACT_COLUMNS.indexOf(col) + 1}`;
}
