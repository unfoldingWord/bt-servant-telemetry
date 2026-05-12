/**
 * Snapshot of bt-servant-worker log event names captured 2026-04-24.
 * Used as a typed enum at the ingest boundary — unknown events are filtered
 * out (and the count is reported separately so we can detect schema drift).
 */
export const KNOWN_EVENTS = [
  'request_received',
  'chat_enqueued',
  'chat_immediate',
  'process_chat_start',
  'process_chat_complete',
  'process_chat_phase',
  'request_timing_summary',
  'do_request_received',
  'webhook_send',
  'webhook_response',
  'orchestration_summary',
  'tool_execution_start',
  'tool_execution_complete',
  'memory_tool_dispatch',
  'claude_request',
  'claude_response',
  'immediate_callback_complete',
  'audio_flow_start',
  'audio_flow_complete',
  'audio_flow_skip',
  'phase_kv_and_routing_complete',
  'phase_do_fetch_complete',
  // error events
  'request_error',
  'chat_busy_final_reject',
  'alarm_fatal_error',
  'tts_generation_failed',
  'mcp_discovery_error',
  'mcp_tool_call_error',
  'audio_get_error',
  'code_execution_error',
] as const;

export type KnownEvent = (typeof KNOWN_EVENTS)[number];

const knownSet = new Set<string>(KNOWN_EVENTS);

export function isKnownEvent(name: string): name is KnownEvent {
  return knownSet.has(name);
}
