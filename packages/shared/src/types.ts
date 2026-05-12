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
};
