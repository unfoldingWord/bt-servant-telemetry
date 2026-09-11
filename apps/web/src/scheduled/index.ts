import type { BackfillEnv } from '../backfill/index.js';
import { flushQueuedTurns, type PostHogEnv } from '../ingest/posthog.js';
import { runAlertSweep } from './alerts.js';
import { runDailyDigest } from './digest.js';
import { runMilestoneWatch } from './milestones.js';
import { runReconcile } from './reconcile.js';
import { consoleSink, type PostIntent, type Sink } from './sink.js';

export type ScheduledEnv = BackfillEnv & PostHogEnv;

// Cron pattern → job name. Kept here (rather than in wrangler.toml)
// because the dispatcher needs to switch on it; wrangler.toml triggers
// must mirror these strings exactly.
export const CRON_RECONCILE = '0 3 * * *';
export const CRON_DIGEST = '0 9 * * *';
export const CRON_ALERT_SWEEP = '*/5 * * * *';
export const CRON_MILESTONE_WATCH = '*/15 * * * *';
export const CRON_POSTHOG_FLUSH = '* * * * *';

export type ScheduledOverrides = {
  sink?: Sink;
  fetchImpl?: typeof fetch;
  nowMs?: number;
};

/** What one job did, for the heartbeat. `fields` is job-specific. */
type TickResult = {
  job: string;
  intents: PostIntent[];
  fields: Record<string, unknown>;
};

/**
 * Every scheduled invocation emits exactly one `cron_tick` line, success or
 * failure. Its *presence* proves the trigger fired — the state that silence
 * used to be indistinguishable from — and its fields say which of the quiet
 * paths the job took (no API key vs. empty queue vs. sent fine). See #42.
 *
 * A tick runs exactly one job, chosen by cron pattern, so `job` identifies it.
 */
function logTick(cron: string, started: number, result: TickResult): void {
  console.log(
    JSON.stringify({
      event: 'cron_tick',
      level: 'info',
      ok: true,
      cron,
      job: result.job,
      ms: Date.now() - started,
      posted: result.intents.length,
      ...result.fields,
    })
  );
}

function logTickFailure(cron: string, started: number, error: unknown): void {
  console.error(
    JSON.stringify({
      event: 'cron_tick',
      level: 'error',
      ok: false,
      cron,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    })
  );
}

export async function scheduledHandler(
  controller: ScheduledController,
  env: ScheduledEnv,
  _ctx: ExecutionContext,
  overrides: ScheduledOverrides = {}
): Promise<void> {
  const sink = overrides.sink ?? consoleSink;
  const fetchImpl = overrides.fetchImpl ?? fetch;
  const nowMs = overrides.nowMs ?? Date.now();
  const started = Date.now();
  try {
    const result = await dispatch(controller.cron, env, nowMs, fetchImpl);
    for (const intent of result.intents) {
      await sink(intent);
    }
    logTick(controller.cron, started, result);
  } catch (error) {
    // Log and rethrow: the heartbeat adds visibility, never swallows.
    logTickFailure(controller.cron, started, error);
    throw error;
  }
}

async function dispatch(
  cron: string,
  env: ScheduledEnv,
  nowMs: number,
  fetchImpl: typeof fetch
): Promise<TickResult> {
  if (cron === CRON_RECONCILE) {
    const { intent, summary } = await runReconcile(env, nowMs, fetchImpl);
    const { pages, fetchedEvents, ingestedEvents } = summary;
    return {
      job: 'reconcile',
      intents: [intent],
      fields: { pages, fetchedEvents, ingestedEvents },
    };
  }
  if (cron === CRON_DIGEST) {
    const { intent } = await runDailyDigest(env.DB, nowMs);
    return { job: 'digest', intents: [intent], fields: {} };
  }
  if (cron === CRON_ALERT_SWEEP) {
    const { intents, conditions } = await runAlertSweep(env.DB, nowMs);
    const firing = conditions.filter((c) => c.firing).map((c) => c.kind);
    return { job: 'alert_sweep', intents, fields: { firing } };
  }
  if (cron === CRON_POSTHOG_FLUSH) {
    // The only PostHog sender. Posts nothing to Zulip.
    const summary = await flushQueuedTurns(env.DB, env, nowMs);
    return { job: 'posthog_flush', intents: [], fields: { ...summary } };
  }
  if (cron === CRON_MILESTONE_WATCH) {
    const { intents, crossings, count } = await runMilestoneWatch(env.DB, nowMs);
    return { job: 'milestone_watch', intents, fields: { users: count, crossed: crossings.length } };
  }
  // Unknown cron pattern — surface loudly. wrangler.toml triggers and
  // the constants above must agree, so an unknown cron means a config
  // drift between deploy and code.
  throw new Error(`scheduled: no handler for cron pattern "${cron}"`);
}

export { runAlertSweep, runDailyDigest, runMilestoneWatch, runReconcile };
export { consoleSink, type PostIntent, type Sink } from './sink.js';
