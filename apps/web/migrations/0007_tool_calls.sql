-- Tool calls and engine build per turn.
--
-- The engine records every tool call the orchestrator made during a turn on
-- the chat_turn record: tool name, owning MCP server, start time, duration and
-- outcome — never arguments or results, which can carry user text. Stored here
-- as one JSON array per turn so the PostHog sender (ingest/posthog.ts) can
-- attach them to the turn as tool_use blocks (what PostHog's Tools tab reads)
-- and emit one $ai_span per call (what draws the trace tree).
--
-- engine_version is the engine build that produced the turn, so any metric
-- can be split by deploy.

ALTER TABLE events ADD COLUMN engine_version TEXT;  -- e.g. "2.49.0"
ALTER TABLE events ADD COLUMN tool_calls TEXT;      -- JSON: [{name, server_id, started_at, duration_ms, ok}, ...]
ALTER TABLE events ADD COLUMN error_type TEXT;      -- failed turns only: bounded error class or code (exit_reason = error)
