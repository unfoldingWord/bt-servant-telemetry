-- Conversation text for PostHog's conversation view: scrubbed, transient.
--
-- The engine puts the user's message and the assistant's reply on every
-- chat_turn record. Tail ingest scrubs personal names and contact details out
-- of both (ingest/scrub.ts) BEFORE anything is written, and spools only the
-- scrubbed text here until the once-a-minute PostHog cron has sent the turn's
-- $ai_generation (ingest/posthog.ts). The sender deletes the row on acceptance
-- and sweeps anything older than a day, so this table is a short queue, never
-- an archive; the insert itself refuses any turn already in events, so a
-- redelivered tail batch can neither resurrect text nobody will collect nor
-- revive a conversation the sweep has dropped. Raw (unscrubbed) text is never
-- stored anywhere in this database.

CREATE TABLE turn_text (
  turn_id TEXT PRIMARY KEY,
  user_message TEXT NOT NULL,
  assistant_reply TEXT NOT NULL,
  created_at INTEGER NOT NULL          -- ms epoch of ingest; drives the stale sweep
);
CREATE INDEX turn_text_created_idx ON turn_text (created_at);

-- Why a turn's text did or did not reach PostHog (ingest/text.ts). One of:
--   off                the record carried no text fields (an older engine)
--   scrubbed           scrubbed and spooled for the sender
--   empty              the record carried text fields but both were blank
--   scrub_unavailable  no ANTHROPIC_API_KEY on this worker; text dropped
--   scrub_failed       the scrubber errored or answered implausibly; text dropped
--   spool_expired      spooled, but unsent for a day; the sweep dropped the text
--
-- Written once, on the delivery that stores the turn: the events insert is
-- INSERT OR IGNORE, so a redelivered tail batch carries this value forward
-- rather than deciding again.
ALTER TABLE events ADD COLUMN text_status TEXT;
