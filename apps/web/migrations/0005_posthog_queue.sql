-- PostHog delivery queue for chat turns.
--
-- Session fields are MUTABLE for a short while after a turn lands: a late or
-- concurrent sibling can shift a stored turn's session_id / turn index (see
-- ingest/sessions.ts). PostHog is append-only, so a turn must not be emitted
-- until its session has settled. Tail ingest stamps posthog_queued_at; a
-- once-a-minute cron (ingest/posthog.ts) sends rows whose stamp is older than
-- the settle window, with the session values D1 holds at that moment, and
-- stamps posthog_emitted_at only once PostHog has accepted them.
--
-- NULL posthog_queued_at means "never queued": rows ingested before this
-- migration, and rows written by the backfill, are not sent to PostHog.

ALTER TABLE events ADD COLUMN posthog_queued_at INTEGER;  -- ms epoch; set by tail ingest
ALTER TABLE events ADD COLUMN posthog_emitted_at INTEGER; -- ms epoch; set once PostHog accepted the event

-- The cron scans only the pending tail of the queue.
CREATE INDEX events_posthog_pending_idx ON events (posthog_queued_at)
  WHERE posthog_queued_at IS NOT NULL AND posthog_emitted_at IS NULL;
