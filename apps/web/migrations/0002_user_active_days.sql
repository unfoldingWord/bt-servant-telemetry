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

-- Backfill from the events table — the actual source of truth for activity.
-- Each event already carries (user_hash, org, ts); we project ts (ms) into
-- a UTC yyyymmdd day key matching what utcDayKey() in upsert.ts computes
-- for new writes. SQLite's strftime takes seconds, so divide by 1000.
-- On a fresh database, events is empty and this insert is a no-op.
INSERT OR IGNORE INTO user_active_days (user_hash, org, day)
  SELECT DISTINCT
    user_hash,
    org,
    CAST(strftime('%Y', ts / 1000, 'unixepoch') AS INTEGER) * 10000 +
    CAST(strftime('%m', ts / 1000, 'unixepoch') AS INTEGER) * 100 +
    CAST(strftime('%d', ts / 1000, 'unixepoch') AS INTEGER)
  FROM events
  WHERE user_hash IS NOT NULL AND org IS NOT NULL;

-- Recompute days_active_count for existing users from the freshly-populated
-- dedupe table. After this migration, days_active_count is always derived
-- from user_active_days by upsertUser(); this UPDATE brings legacy rows
-- into alignment in a single step. The COALESCE(..., 1) preserves the
-- default for any users row that has no matching events (shouldn't happen
-- under normal ingest, but defensive).
UPDATE users SET days_active_count = COALESCE(
  (SELECT COUNT(*) FROM user_active_days
   WHERE user_active_days.user_hash = users.user_hash
     AND user_active_days.org = users.org),
  1
)
WHERE EXISTS (
  SELECT 1 FROM user_active_days
  WHERE user_active_days.user_hash = users.user_hash
    AND user_active_days.org = users.org
);
