-- Initial schema for bt-servant-telemetry.
-- All user identifiers stored as HMAC-SHA-256 hashes — never raw.

CREATE TABLE users (
  user_hash TEXT NOT NULL,
  org TEXT NOT NULL,
  client_id TEXT NOT NULL,
  first_seen_ts INTEGER NOT NULL,
  last_seen_ts INTEGER NOT NULL,
  days_active_count INTEGER NOT NULL DEFAULT 1,
  last_active_day INTEGER NOT NULL,            -- yyyymmdd UTC, used to detect new active day
  first_interaction_transition_ts INTEGER,
  PRIMARY KEY (user_hash, org)
);

CREATE INDEX users_first_seen_idx ON users (first_seen_ts);
CREATE INDEX users_last_seen_idx ON users (last_seen_ts);

CREATE TABLE events (
  request_id TEXT NOT NULL,
  event TEXT NOT NULL,
  ts INTEGER NOT NULL,
  level TEXT,                                  -- 'error' on error events, NULL otherwise
  org TEXT,
  user_hash TEXT,
  client_id TEXT,
  total_ms INTEGER,
  duration_ms INTEGER,
  chat_type TEXT,
  transport TEXT,
  tool_name TEXT,
  server_id TEXT,
  PRIMARY KEY (request_id, event, ts)
);

CREATE INDEX events_ts_idx ON events (ts);
CREATE INDEX events_event_ts_idx ON events (event, ts);
CREATE INDEX events_user_idx ON events (user_hash, ts);
CREATE INDEX events_level_idx ON events (level, ts);

-- Phase 6 — alert dedupe
CREATE TABLE posted_alerts (
  alert_kind TEXT NOT NULL,
  posted_ts INTEGER NOT NULL,
  PRIMARY KEY (alert_kind)
);

-- Phase 6 — milestone dedupe
CREATE TABLE reached_milestones (
  milestone INTEGER NOT NULL,
  reached_ts INTEGER NOT NULL,
  PRIMARY KEY (milestone)
);
