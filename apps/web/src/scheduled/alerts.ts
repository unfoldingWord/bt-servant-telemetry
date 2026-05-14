import { ALERT_KINDS, type AlertKind, type PostIntent } from './sink.js';

const FIVE_MIN_MS = 5 * 60 * 1000;
const TEN_MIN_MS = 10 * 60 * 1000;
const ERROR_RATE_THRESHOLD_PCT = 2;

export type AlertCondition = {
  kind: AlertKind;
  firing: boolean;
  detail: string;
};

/**
 * Alert sweeper — fires every 5 minutes.
 *
 * Two alert kinds:
 * - `worker_offline` — zero events in the last 5 min. Checked first;
 *   if firing, suppresses `error_rate_high` to avoid double-paging on
 *   the same outage.
 * - `error_rate_high` — error rate > 2% over the last 10 min.
 *
 * Dedupe via posted_alerts (alert_kind PK):
 * - When firing for the first time (no row): emit intent + INSERT row.
 * - When firing again with row present: skip (already paged).
 * - When not firing and row present: DELETE row so the next fresh
 *   breach can page again. (No "recovered" notification — explicit
 *   non-goal in the plan.)
 */
export async function runAlertSweep(
  db: D1Database,
  nowMs: number
): Promise<{ intents: PostIntent[]; conditions: AlertCondition[] }> {
  const conditions = await evaluate(db, nowMs);
  const intents: PostIntent[] = [];
  for (const condition of conditions) {
    const transitioned = await reconcileDedupe(db, condition, nowMs);
    if (transitioned === 'first-fire') {
      intents.push({
        kind: 'alert',
        alertKind: condition.kind,
        markdown: formatAlert(condition),
      });
    }
  }
  return { intents, conditions };
}

async function evaluate(db: D1Database, nowMs: number): Promise<AlertCondition[]> {
  const since5m = nowMs - FIVE_MIN_MS;
  const since10m = nowMs - TEN_MIN_MS;
  const [recent, window10] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE ts >= ?`)
      .bind(since5m)
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) AS errors
           FROM events WHERE ts >= ? AND user_hash IS NOT NULL AND org IS NOT NULL`
      )
      .bind(since10m)
      .first<{ total: number; errors: number | null }>(),
  ]);

  const eventsLast5m = recent?.n ?? 0;
  const offline = eventsLast5m === 0;
  const total10m = window10?.total ?? 0;
  const errors10m = window10?.errors ?? 0;
  const errorRatePct = total10m === 0 ? 0 : Math.round((errors10m / total10m) * 10000) / 100;

  return [
    {
      kind: 'worker_offline',
      firing: offline,
      detail: `0 events in the last 5 min (window ending ${new Date(nowMs).toISOString()})`,
    },
    {
      kind: 'error_rate_high',
      // Suppressed when worker_offline is firing — same incident, one page.
      firing: !offline && errorRatePct > ERROR_RATE_THRESHOLD_PCT,
      detail: `error rate ${errorRatePct}% over last 10 min (${errors10m}/${total10m} events)`,
    },
  ];
}

type DedupeOutcome = 'first-fire' | 'still-firing' | 'cleared' | 'still-clear';

// Race-safe: derive first-fire from the write itself, not from a prior
// SELECT. Two overlapping cron runs that both observe "no row" would
// otherwise both attempt INSERT and one would crash the sweep on the PK
// violation. INSERT OR IGNORE collapses the race — the loser sees
// meta.changes === 0 and treats it as still-firing.
async function reconcileDedupe(
  db: D1Database,
  condition: AlertCondition,
  nowMs: number
): Promise<DedupeOutcome> {
  if (condition.firing) {
    const result = await db
      .prepare(`INSERT OR IGNORE INTO posted_alerts (alert_kind, posted_ts) VALUES (?, ?)`)
      .bind(condition.kind, nowMs)
      .run();
    return result.meta.changes === 1 ? 'first-fire' : 'still-firing';
  }
  // DELETE is already idempotent; meta.changes tells us whether the row
  // existed before this run. No SELECT needed.
  const result = await db
    .prepare(`DELETE FROM posted_alerts WHERE alert_kind = ?`)
    .bind(condition.kind)
    .run();
  return result.meta.changes === 1 ? 'cleared' : 'still-clear';
}

function formatAlert(condition: AlertCondition): string {
  const title = condition.kind === 'worker_offline' ? 'Worker may be offline' : 'Error rate high';
  return `**${title}**\n${condition.detail}`;
}

// Re-export so callers can import all alert kinds without reaching into sink.
export { ALERT_KINDS };
