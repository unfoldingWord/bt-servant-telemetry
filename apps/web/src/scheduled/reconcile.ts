import { runBackfill, type BackfillEnv, type BackfillSummary } from '../backfill/index.js';
import type { PostIntent } from './sink.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Daily reconciliation backfill (cron `0 3 * * *`).
 *
 * Re-ingests the last 24 hours via the Workers Observability Telemetry
 * API. The same redact → upsert pipeline as the live tail handler runs,
 * and ingestBatch is idempotent on (request_id, event, ts) and
 * (user_hash, org), so re-running over already-ingested rows is a no-op.
 *
 * Patches over tail-handler downtime, missed events, or schema drift
 * without affecting the live path.
 */
export async function runReconcile(
  env: BackfillEnv,
  nowMs: number,
  fetchImpl: typeof fetch = fetch
): Promise<{ intent: PostIntent; summary: BackfillSummary }> {
  const summary = await runBackfill(env, { since: nowMs - ONE_DAY_MS, until: nowMs }, fetchImpl);
  return { intent: { kind: 'reconcile', markdown: formatReconcile(summary) }, summary };
}

function formatReconcile(s: BackfillSummary): string {
  return [
    '**Reconciliation backfill complete**',
    `- pages: ${s.pages}`,
    `- fetched events: ${s.fetchedEvents}`,
    `- raw messages: ${s.rawMessages}`,
    `- ingested events: ${s.ingestedEvents}`,
    `- window: ${new Date(s.since).toISOString()} → ${new Date(s.until).toISOString()}`,
  ].join('\n');
}
