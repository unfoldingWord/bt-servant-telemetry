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

  const crossings: MilestoneCrossing[] = [];
  const intents: PostIntent[] = [];
  for (const threshold of MILESTONE_THRESHOLDS) {
    if (count < threshold) break; // ascending order — short-circuit
    // Race-safe: try to claim the milestone via INSERT OR IGNORE and
    // emit only if this run actually wrote the row. Two overlapping
    // runs that both saw the same prior snapshot would otherwise both
    // INSERT and the loser would crash on the PK violation, aborting
    // any later thresholds in the loop.
    const result = await db
      .prepare(`INSERT OR IGNORE INTO reached_milestones (milestone, reached_ts) VALUES (?, ?)`)
      .bind(threshold, nowMs)
      .run();
    if (result.meta.changes !== 1) continue;
    crossings.push({ milestone: threshold, count });
    intents.push({
      kind: 'milestone',
      milestone: threshold,
      markdown: formatMilestone(threshold, count),
    });
  }
  return { intents, crossings };
}

async function currentAllTimeUsers(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>();
  return row?.n ?? 0;
}

function formatMilestone(milestone: number, count: number): string {
  return [
    `**Milestone reached: ${milestone.toLocaleString('en-US')} distinct users**`,
    `Current all-time count: ${count.toLocaleString('en-US')}`,
  ].join('\n');
}
