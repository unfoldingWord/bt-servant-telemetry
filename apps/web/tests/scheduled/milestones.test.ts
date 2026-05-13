import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMilestoneWatch } from '../../src/scheduled/index.js';

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
  await env.DB.exec('DELETE FROM users');
  await env.DB.exec('DELETE FROM reached_milestones');
});

const NOW = Date.UTC(2026, 4, 12, 12, 0, 0);

async function seedUsers(n: number, startIndex = 0): Promise<void> {
  // PK is (user_hash, org). Each row is a unique user.
  for (let i = 0; i < n; i++) {
    await env.DB.prepare(
      `INSERT INTO users
        (user_hash, org, client_id, first_seen_ts, last_seen_ts, last_active_day)
       VALUES (?, ?, 'web', ?, ?, ?)`
    )
      .bind(String(startIndex + i).padStart(8, 'u'), 'org-a', NOW, NOW, 20260512)
      .run();
  }
}

describe('runMilestoneWatch', () => {
  it('emits no intent when below the lowest threshold', async () => {
    await seedUsers(50);
    const { intents } = await runMilestoneWatch(env.DB, NOW);
    expect(intents).toEqual([]);
  });

  it('emits intents for all crossed thresholds and inserts dedupe rows', async () => {
    await seedUsers(1234);
    const { intents, crossings } = await runMilestoneWatch(env.DB, NOW);
    expect(crossings.map((c) => c.milestone)).toEqual([100, 500, 1000]);
    expect(intents.map((i) => i.kind === 'milestone' && i.milestone)).toEqual([100, 500, 1000]);

    const { results } = await env.DB.prepare(
      `SELECT milestone FROM reached_milestones ORDER BY milestone`
    ).all<{ milestone: number }>();
    expect(results.map((r) => r.milestone)).toEqual([100, 500, 1000]);
  });

  it('does not re-emit a milestone that is already in reached_milestones', async () => {
    await seedUsers(150);
    await runMilestoneWatch(env.DB, NOW);
    const { intents, crossings } = await runMilestoneWatch(env.DB, NOW + 1);
    expect(crossings).toEqual([]);
    expect(intents).toEqual([]);
  });

  it('is idempotent when a parallel run has already claimed an earlier threshold', async () => {
    // Simulate the race: another concurrent watch wrote reached_milestones
    // for 100 between this run's snapshot and its INSERT. Old code would
    // crash on PK violation when this run's loop hit 100, aborting later
    // thresholds. INSERT OR IGNORE must skip 100 silently and still
    // emit 500.
    await seedUsers(550);
    await env.DB.prepare(`INSERT INTO reached_milestones (milestone, reached_ts) VALUES (100, ?)`)
      .bind(NOW - 1000)
      .run();
    const { intents, crossings } = await runMilestoneWatch(env.DB, NOW);
    expect(crossings.map((c) => c.milestone)).toEqual([500]);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ kind: 'milestone', milestone: 500 });
  });

  it('only emits the newly crossed milestone when the user count grows', async () => {
    await seedUsers(150);
    await runMilestoneWatch(env.DB, NOW); // emits 100
    await seedUsers(400, 150); // disjoint hashes; total now 550
    const { intents, crossings } = await runMilestoneWatch(env.DB, NOW + 1);
    expect(crossings.map((c) => c.milestone)).toEqual([500]);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ kind: 'milestone', milestone: 500 });
  });
});
