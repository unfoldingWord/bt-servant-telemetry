-- Conversation stitching for chat turns.
--
-- The engine has no conversation id to emit: on WhatsApp the conversation IS
-- the user's durable object. This worker derives one instead. On ingest, each
-- chat_turn looks up the same user's previous chat_turn (events_user_idx);
-- within the configured inactivity gap it joins that session, otherwise it
-- starts a new one named after its own turn_id. See ingest/sessions.ts.
--
-- Both columns are nullable and populated only for event = 'chat_turn'.
-- Additive against the existing PK, no backfill: historical rows read NULL.

ALTER TABLE events ADD COLUMN session_id TEXT;            -- turn_id of the session's first turn
ALTER TABLE events ADD COLUMN session_turn_index INTEGER; -- 1-based position within the session

-- Per-session rollups ("how many turns does a conversation run") group by this.
CREATE INDEX events_session_idx ON events (session_id);
