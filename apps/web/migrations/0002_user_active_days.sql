-- Order-independent active-day tracking.
-- The Phase 1/2 design counted distinct days via an order-sensitive comparison
-- in the users UPSERT (excluded.last_active_day > users.last_active_day).
-- That undercounts when tail/backfill delivers a newer day before an older
-- one. This table dedupes per (user_hash, org, day) so the count is the
-- true number of distinct active days regardless of ingest order.

CREATE TABLE user_active_days (
  user_hash TEXT NOT NULL,
  org TEXT NOT NULL,
  day INTEGER NOT NULL,                        -- yyyymmdd UTC
  PRIMARY KEY (user_hash, org, day)
);

CREATE INDEX user_active_days_user_idx ON user_active_days (user_hash, org);

-- Backfill existing rows: every user has at least one active day (their
-- recorded last_active_day). On a fresh database this is a no-op.
INSERT OR IGNORE INTO user_active_days (user_hash, org, day)
  SELECT user_hash, org, last_active_day FROM users;
