-- Per-turn LLM facts, landed alongside the bt-servant-worker turn-telemetry change.
--
-- Until now the `events` table could record THAT a turn happened but nothing
-- about it: not the model that answered, not what it cost, not which mode
-- governed it, not how many steps it took. `chat_turn` was not even in
-- KNOWN_EVENTS, so those rows were dropped at the ingest boundary entirely.
--
-- All columns are nullable and populated only for `event = 'chat_turn'`. That
-- is deliberate: the events table is a single flat table shared by ~30 event
-- types and is already fully nullable past the primary key. Additive nullable
-- columns are safe against the existing PK (request_id, event, ts) — no
-- backfill, no rewrite, and older rows simply read NULL.
--
-- No free text lands here. Every column is a bounded enum, an opaque id, a
-- model name, or a number, matching the redaction discipline in redact.ts.

-- Join key to the generation-level orchestrator logs. Distinct from request_id,
-- which drainQueue reuses across the entries it drains and which therefore
-- cannot identify a single turn.
ALTER TABLE events ADD COLUMN turn_id TEXT;

-- Mode that GOVERNED the turn (the mode in force at turn start). This is the
-- attribution key for "which modes are used" and for cost-by-mode.
ALTER TABLE events ADD COLUMN mode TEXT;
-- Mode selected mid-turn via the switch_mode tool. It applies to the user's
-- NEXT message ("This will take effect on your next message"), so it is a
-- forward-looking signal and must never be used to attribute this turn.
ALTER TABLE events ADD COLUMN mode_switched_to TEXT;

ALTER TABLE events ADD COLUMN language TEXT;
ALTER TABLE events ADD COLUMN language_source TEXT;
ALTER TABLE events ADD COLUMN response_language TEXT;

-- Country from the user's phone number where the channel allows deriving it.
ALTER TABLE events ADD COLUMN user_country TEXT;
-- Country of the serving edge. For gateway-relayed traffic this is the
-- GATEWAY's egress location, not the user's — which is why the two are
-- separate columns and neither falls back to the other.
ALTER TABLE events ADD COLUMN edge_country TEXT;

ALTER TABLE events ADD COLUMN model TEXT;
ALTER TABLE events ADD COLUMN iterations INTEGER;
ALTER TABLE events ADD COLUMN exit_reason TEXT;
ALTER TABLE events ADD COLUMN stop_reason TEXT;
ALTER TABLE events ADD COLUMN mcp_calls_made INTEGER;

-- Token counts are SUMMED across every iteration of the turn, not per API call.
-- A turn can run many generations; its cost is their sum.
ALTER TABLE events ADD COLUMN input_tokens INTEGER;
ALTER TABLE events ADD COLUMN output_tokens INTEGER;
ALTER TABLE events ADD COLUMN cache_creation_input_tokens INTEGER;
ALTER TABLE events ADD COLUMN cache_read_input_tokens INTEGER;
-- Base-rate-equivalent input tokens. Subtract from the true prompt size
-- (input + cache_creation + cache_read) to get what caching saved.
ALTER TABLE events ADD COLUMN billable_input_tokens INTEGER;

-- SQLite has no boolean type; 0/1, NULL when unknown. Voice turns additionally
-- incur STT and TTS spend that the token columns above do NOT capture, so these
-- flags exist to keep a per-transport cost comparison honest.
ALTER TABLE events ADD COLUMN had_inbound_voice INTEGER;
ALTER TABLE events ADD COLUMN had_outbound_voice INTEGER;

-- Turn-level rollups are always scoped to a time range, and events_event_ts_idx
-- (event, ts) already serves that. The extra index here is for joining a turn
-- back to its generation-level records, which has no covering index today.
CREATE INDEX events_turn_idx ON events (turn_id);
