import type { PostIntent } from './sink.js';

export const MILESTONE_THRESHOLDS = [100, 500, 1000, 5000, 10000, 25000, 50000] as const;

export type MilestoneCrossing = {
  milestone: number;
  count: number;
};

/**
 * Milestone watcher — fires every 15 minutes.
 *
 * Posts when the all-time distinct-user counter newly crosses a
 * threshold. Dedupe via reached_milestones (milestone PK): each
 * threshold is announced exactly once across the lifetime of the
 * counter. The counter only ever moves forward, so we never delete
 * milestone rows — unlike alert dedupe.
 */
export async function runMilestoneWatch(
  db: D1Database,
  nowMs: number
): Promise<{ intents: PostIntent[]; crossings: MilestoneCrossing[] }> {
  const count = await currentAllTimeUsers(db);
  const reached = await loadReachedMilestones(db);

  const crossings: MilestoneCrossing[] = [];
  const intents: PostIntent[] = [];
  for (const threshold of MILESTONE_THRESHOLDS) {
    if (count < threshold) break; // ascending order — short-circuit
    if (reached.has(threshold)) continue;
    crossings.push({ milestone: threshold, count });
    intents.push({
      kind: 'milestone',
      milestone: threshold,
      markdown: formatMilestone(threshold, count),
    });
    await db
      .prepare(`INSERT INTO reached_milestones (milestone, reached_ts) VALUES (?, ?)`)
      .bind(threshold, nowMs)
      .run();
  }
  return { intents, crossings };
}

async function currentAllTimeUsers(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>();
  return row?.n ?? 0;
}

async function loadReachedMilestones(db: D1Database): Promise<Set<number>> {
  const { results } = await db
    .prepare(`SELECT milestone FROM reached_milestones`)
    .all<{ milestone: number }>();
  return new Set(results.map((r) => r.milestone));
}

function formatMilestone(milestone: number, count: number): string {
  return [
    `**Milestone reached: ${milestone.toLocaleString('en-US')} distinct users**`,
    `Current all-time count: ${count.toLocaleString('en-US')}`,
  ].join('\n');
}
