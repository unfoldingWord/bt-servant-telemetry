import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import type { CleanEvent } from '@bt-servant-telemetry/shared';
import { upsertUser, ingestBatch } from '../../src/ingest/upsert.js';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM events');
  await env.DB.exec('DELETE FROM users');
  await env.DB.exec('DELETE FROM user_active_days');
});

const DAY_A_MS = Date.UTC(2026, 3, 24, 12, 0, 0); // 2026-04-24 12:00 UTC -> day 20260424
const DAY_B_MS = Date.UTC(2026, 3, 25, 13, 0, 0); // 2026-04-25 13:00 UTC -> day 20260425
const DAY_C_MS = Date.UTC(2026, 3, 26, 14, 0, 0); // 2026-04-26 14:00 UTC -> day 20260426

function makeEvent(overrides: Partial<CleanEvent> & Pick<CleanEvent, 'ts'>): CleanEvent {
  return {
    event: 'request_received',
    level: null,
    org: 'unfoldingWord',
    user_hash: 'a'.repeat(64),
    client_id: 'web',
    request_id: `req-${overrides.ts}`,
    total_ms: null,
    duration_ms: null,
    chat_type: null,
    transport: null,
    tool_name: null,
    server_id: null,
    first_interaction: null,
    ...overrides,
  };
}

async function readUser(): Promise<{
  days_active_count: number;
  last_active_day: number;
  first_seen_ts: number;
  last_seen_ts: number;
  first_interaction_transition_ts: number | null;
} | null> {
  return env.DB.prepare(
    `SELECT days_active_count, last_active_day, first_seen_ts, last_seen_ts,
            first_interaction_transition_ts
     FROM users WHERE user_hash = ? AND org = ?`
  )
    .bind('a'.repeat(64), 'unfoldingWord')
    .first();
}

describe('upsertUser is order-independent', () => {
  it('days_active_count is correct when newer day arrives before older day', async () => {
    // Out-of-order: day B (later) first, then day A (earlier).
    await upsertUser(env.DB, makeEvent({ ts: DAY_B_MS }));
    await upsertUser(env.DB, makeEvent({ ts: DAY_A_MS }));

    const row = await readUser();
    expect(row?.days_active_count).toBe(2);
    expect(row?.last_active_day).toBe(20260425);
    expect(row?.first_seen_ts).toBe(DAY_A_MS);
    expect(row?.last_seen_ts).toBe(DAY_B_MS);
  });

  it('produces the same final state regardless of ingest order', async () => {
    // Order 1: A, B, C
    await upsertUser(env.DB, makeEvent({ ts: DAY_A_MS }));
    await upsertUser(env.DB, makeEvent({ ts: DAY_B_MS }));
    await upsertUser(env.DB, makeEvent({ ts: DAY_C_MS }));
    const forward = await readUser();

    await env.DB.exec('DELETE FROM users');
    await env.DB.exec('DELETE FROM user_active_days');

    // Order 2: C, A, B (scrambled)
    await upsertUser(env.DB, makeEvent({ ts: DAY_C_MS }));
    await upsertUser(env.DB, makeEvent({ ts: DAY_A_MS }));
    await upsertUser(env.DB, makeEvent({ ts: DAY_B_MS }));
    const scrambled = await readUser();

    expect(scrambled).toEqual(forward);
    expect(scrambled?.days_active_count).toBe(3);
  });

  it('same-day duplicate events do not inflate the day count', async () => {
    // Three events, all same day.
    await upsertUser(env.DB, makeEvent({ ts: DAY_A_MS }));
    await upsertUser(env.DB, makeEvent({ ts: DAY_A_MS + 3600_000 }));
    await upsertUser(env.DB, makeEvent({ ts: DAY_A_MS + 7200_000 }));

    const row = await readUser();
    expect(row?.days_active_count).toBe(1);
  });

  it('first_interaction_transition_ts picks the earliest transition regardless of arrival order', async () => {
    // Arrive: later first_interaction → earlier first_interaction → non-transition event.
    await upsertUser(env.DB, makeEvent({ ts: DAY_C_MS, first_interaction: true }));
    await upsertUser(env.DB, makeEvent({ ts: DAY_A_MS, first_interaction: true }));
    await upsertUser(env.DB, makeEvent({ ts: DAY_B_MS, first_interaction: null }));

    const row = await readUser();
    expect(row?.first_interaction_transition_ts).toBe(DAY_A_MS);
  });

  it('first_interaction_transition_ts is set by the first transition seen even if a non-transition event arrived first', async () => {
    // Arrive: non-transition (ts=A) → transition (ts=B) → non-transition (ts=C).
    await upsertUser(env.DB, makeEvent({ ts: DAY_A_MS, first_interaction: null }));
    await upsertUser(env.DB, makeEvent({ ts: DAY_B_MS, first_interaction: true }));
    await upsertUser(env.DB, makeEvent({ ts: DAY_C_MS, first_interaction: null }));

    const row = await readUser();
    expect(row?.first_interaction_transition_ts).toBe(DAY_B_MS);
  });

  it('first_interaction_transition_ts stays null when no transition event ever arrives', async () => {
    await upsertUser(env.DB, makeEvent({ ts: DAY_A_MS, first_interaction: null }));
    await upsertUser(env.DB, makeEvent({ ts: DAY_B_MS, first_interaction: false }));

    const row = await readUser();
    expect(row?.first_interaction_transition_ts).toBeNull();
  });
});

describe('migration 0002 backfill (existing-data parity)', () => {
  // The migration must repopulate user_active_days from the events table
  // and recompute users.days_active_count, so PR-preview/dev databases that
  // accumulated activity under the order-sensitive 0001 schema get the
  // corrected counts after upgrading. We exercise the migration's backfill
  // SQL inline against seeded data — applyD1Migrations runs once at suite
  // setup, so we simulate "pre-0002 state" by clearing user_active_days
  // and recomputing.
  const USER_HASH = 'b'.repeat(64);
  const ORG = 'wordcollective';

  beforeEach(async () => {
    // Seed events across 3 distinct UTC days for one user.
    const insertEvent = env.DB.prepare(
      `INSERT INTO events (request_id, event, ts, level, org, user_hash, client_id)
       VALUES (?, ?, ?, NULL, ?, ?, 'web')`
    );
    await insertEvent.bind('req-1', 'request_received', DAY_A_MS, ORG, USER_HASH).run();
    await insertEvent.bind('req-2', 'request_received', DAY_A_MS + 3600_000, ORG, USER_HASH).run();
    await insertEvent.bind('req-3', 'request_received', DAY_B_MS, ORG, USER_HASH).run();
    await insertEvent.bind('req-4', 'request_received', DAY_C_MS, ORG, USER_HASH).run();

    // Seed a users row whose days_active_count is stale (the bug we're
    // fixing — order-sensitive UPSERT could have left it at 1 when truth
    // is 3).
    await env.DB.prepare(
      `INSERT INTO users (user_hash, org, client_id, first_seen_ts, last_seen_ts,
                          days_active_count, last_active_day)
       VALUES (?, ?, 'web', ?, ?, 1, 20260426)`
    )
      .bind(USER_HASH, ORG, DAY_A_MS, DAY_C_MS)
      .run();

    // Wipe user_active_days to simulate "0002 has not yet backfilled".
    await env.DB.exec('DELETE FROM user_active_days');
  });

  it('repopulates user_active_days from events and recomputes days_active_count', async () => {
    // Same SQL as migration 0002 — kept in sync intentionally to detect
    // drift between the migration file and the recompute logic.
    // D1's exec() splits on newlines, so we use prepare/run for multi-line.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO user_active_days (user_hash, org, day)
       SELECT DISTINCT user_hash, org,
         CAST(strftime('%Y', ts / 1000, 'unixepoch') AS INTEGER) * 10000 +
         CAST(strftime('%m', ts / 1000, 'unixepoch') AS INTEGER) * 100 +
         CAST(strftime('%d', ts / 1000, 'unixepoch') AS INTEGER)
       FROM events
       WHERE user_hash IS NOT NULL AND org IS NOT NULL`
    ).run();
    await env.DB.prepare(
      `UPDATE users SET days_active_count = COALESCE(
         (SELECT COUNT(*) FROM user_active_days
          WHERE user_active_days.user_hash = users.user_hash
            AND user_active_days.org = users.org),
         1
       )
       WHERE EXISTS (
         SELECT 1 FROM user_active_days
         WHERE user_active_days.user_hash = users.user_hash
           AND user_active_days.org = users.org
       )`
    ).run();

    const dayRows = await env.DB.prepare(
      `SELECT day FROM user_active_days WHERE user_hash = ? AND org = ? ORDER BY day`
    )
      .bind(USER_HASH, ORG)
      .all<{ day: number }>();
    expect(dayRows.results.map((r) => r.day)).toEqual([20260424, 20260425, 20260426]);

    const userRow = await env.DB.prepare(
      `SELECT days_active_count FROM users WHERE user_hash = ? AND org = ?`
    )
      .bind(USER_HASH, ORG)
      .first<{ days_active_count: number }>();
    expect(userRow?.days_active_count).toBe(3);
  });
});

describe('ingestBatch order-independence (end-to-end)', () => {
  it('produces identical user rows for forward vs reversed event order', async () => {
    const events: CleanEvent[] = [
      makeEvent({ ts: DAY_A_MS, first_interaction: true }),
      makeEvent({ ts: DAY_B_MS, first_interaction: null }),
      makeEvent({ ts: DAY_C_MS, first_interaction: null }),
    ];

    await ingestBatch(env.DB, events);
    const forward = await readUser();

    await env.DB.exec('DELETE FROM events');
    await env.DB.exec('DELETE FROM users');
    await env.DB.exec('DELETE FROM user_active_days');

    await ingestBatch(env.DB, [...events].reverse());
    const reversed = await readUser();

    expect(reversed).toEqual(forward);
    expect(reversed?.days_active_count).toBe(3);
    expect(reversed?.first_interaction_transition_ts).toBe(DAY_A_MS);
  });
});
