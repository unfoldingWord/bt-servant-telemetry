/**
 * One tool call the engine made during a turn — names and numbers only, never
 * the arguments or the result, which can carry user text.
 */
export type ToolCallRecord = {
  /** Tool name as the model called it (e.g. `fetch_scripture`). */
  name: string;
  /** MCP server that owns the tool; null for engine-hosted tools. */
  server_id: string | null;
  /** Epoch ms when the call started. */
  started_at: number;
  duration_ms: number;
  ok: boolean;
};

/**
 * Shape produced by the ingest boundary. Every PII-bearing field has been
 * dropped or hashed by the time a CleanEvent exists.
 */
export type CleanEvent = {
  event: string;
  ts: number;
  level: string | null;
  org: string | null;
  user_hash: string | null;
  client_id: string | null;
  request_id: string;
  total_ms: number | null;
  duration_ms: number | null;
  chat_type: string | null;
  transport: string | null;
  tool_name: string | null;
  server_id: string | null;
  // Side-channel: side-effects on users table when present, never stored on events.
  first_interaction: boolean | null;

  // ── chat_turn only ────────────────────────────────────────────────────────
  // Null on every other event. Flat rather than nested to match the events
  // table, which is flat and fully nullable by design. These are the per-turn
  // facts bt-servant-worker started emitting in its turn-telemetry change: what
  // answered, what it cost, how many steps it took and why it stopped.
  //
  // No free-text ever lands here. Every field is a bounded enum, an opaque id,
  // a model name, or a number — the same discipline the rest of this type keeps.
  // Conversation text is scrubbed and spooled SEPARATELY (ingest/text.ts) and
  // is deliberately not part of this type, so the events table cannot carry it.
  /** Per-turn id. Joins this row to the generation-level orchestrator logs. */
  turn_id: string | null;
  /** Mode that GOVERNED the turn (mode at turn start). The attribution key. */
  mode: string | null;
  /** Mode selected mid-turn via switch_mode; applies to the user's NEXT turn.
   *  Never use this to attribute a turn — see the worker's OrchestrationTelemetry. */
  mode_switched_to: string | null;
  /** Resolved active language for the turn. */
  language: string | null;
  /** How the language was resolved — bounded enum. */
  language_source: string | null;
  /** Language the reply was written in. Distinct from `language`. */
  response_language: string | null;
  /** Country derived from the user's phone number, where the channel allows it. */
  user_country: string | null;
  /** Country of the edge that served the request — the GATEWAY's egress for
   *  relayed traffic, which is why it never falls back to user_country. */
  edge_country: string | null;
  /** Model requested for the turn. */
  model: string | null;
  /** Orchestration iterations actually run. */
  iterations: number | null;
  /** How the orchestration loop exited — bounded enum. `error` marks a turn
   *  that failed for good and never answered (see `error_type`). */
  exit_reason: string | null;
  /** stop_reason of the final Anthropic response. */
  stop_reason: string | null;
  /** MCP/host-function calls made during the turn. */
  mcp_calls_made: number | null;
  /** Token counts SUMMED across every iteration of the turn, not per call. */
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  /** Base-rate-equivalent input tokens — what the turn actually costs. */
  billable_input_tokens: number | null;
  /** Turn came from a voice message (STT spend, not captured here). */
  had_inbound_voice: boolean | null;
  /** Turn produced a voice reply (TTS spend, not captured here). */
  had_outbound_voice: boolean | null;
  /** Why the turn's conversation text did or did not reach PostHog — a bounded
   *  enum stamped at ingest (ingest/text.ts). Never the text itself. */
  text_status: string | null;
  /** Build of the engine that produced the turn, so any metric can be split by deploy. */
  engine_version: string | null;
  /** The tool calls the orchestrator made this turn, in order (ingest/tool-calls.ts).
   *  Names, servers and timings only — never arguments. Stored as JSON in D1. */
  tool_calls: ToolCallRecord[] | null;
  /** Failed turns only: the engine's bounded error class or code (e.g.
   *  `MCPError`, `RATE_LIMIT_EXCEEDED`). Never the error message. */
  error_type: string | null;
  /** Derived at ingest (ingest/sessions.ts): turn_id of the session's first turn. */
  session_id: string | null;
  /** Derived at ingest: 1-based position of this turn within its session. */
  session_turn_index: number | null;
};

/** The chat_turn-only half of CleanEvent. */
export type TurnFacts = Pick<
  CleanEvent,
  | 'turn_id'
  | 'mode'
  | 'mode_switched_to'
  | 'language'
  | 'language_source'
  | 'response_language'
  | 'user_country'
  | 'edge_country'
  | 'model'
  | 'iterations'
  | 'exit_reason'
  | 'stop_reason'
  | 'mcp_calls_made'
  | 'input_tokens'
  | 'output_tokens'
  | 'cache_creation_input_tokens'
  | 'cache_read_input_tokens'
  | 'billable_input_tokens'
  | 'had_inbound_voice'
  | 'had_outbound_voice'
  | 'text_status'
  | 'engine_version'
  | 'tool_calls'
  | 'error_type'
  | 'session_id'
  | 'session_turn_index'
>;

/**
 * Every turn fact, null. Spread this when constructing a CleanEvent for any
 * NON-chat_turn event.
 *
 * The fields are deliberately REQUIRED on CleanEvent rather than optional, so
 * adding one is a compile error at every construction site instead of silently
 * writing NULL — which is exactly how this ingest schema drifted away from the
 * worker's log shape before.
 */
export const NO_TURN_FACTS: TurnFacts = {
  turn_id: null,
  mode: null,
  mode_switched_to: null,
  language: null,
  language_source: null,
  response_language: null,
  user_country: null,
  edge_country: null,
  model: null,
  iterations: null,
  exit_reason: null,
  stop_reason: null,
  mcp_calls_made: null,
  input_tokens: null,
  output_tokens: null,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  billable_input_tokens: null,
  had_inbound_voice: null,
  had_outbound_voice: null,
  text_status: null,
  engine_version: null,
  tool_calls: null,
  error_type: null,
  session_id: null,
  session_turn_index: null,
};
