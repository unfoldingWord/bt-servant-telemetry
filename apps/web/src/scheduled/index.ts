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
  intents: PostIntent[];
  fields: Record<string, unknown>;
};

/**
 * Cron pattern → heartbeat job name. The single source of both payloads' `job`,
 * resolved BEFORE dispatch runs: a job that throws must still be filterable by
 * `job`, or `job = "posthog_flush"` would silently return nothing for exactly
 * the invocations that failed — the ambiguity the heartbeat exists to remove.
 *
 * A Map rather than an object literal so the lookup is not an injection sink.
 */
const JOB_BY_CRON = new Map<string, string>([
  [CRON_RECONCILE, 'reconcile'],
  [CRON_DIGEST, 'digest'],
  [CRON_ALERT_SWEEP, 'alert_sweep'],
  [CRON_POSTHOG_FLUSH, 'posthog_flush'],
  [CRON_MILESTONE_WATCH, 'milestone_watch'],
]);

/** `unknown` covers the config-drift case, which throws in `dispatch`. */
export function jobForCron(cron: string): string {
  return JOB_BY_CRON.get(cron) ?? 'unknown';
}

/**
 * Every scheduled invocation emits exactly one `cron_tick` line, success or
 * failure. Its *presence* proves the trigger fired — the state that silence
 * used to be indistinguishable from — and its fields say which of the quiet
 * paths the job took (no API key vs. empty queue vs. sent fine). See #42.
 *
 * A tick runs exactly one job, chosen by cron pattern, so `job` identifies it.
 */
function logTick(cron: string, job: string, started: number, result: TickResult): void {
  console.log(
    JSON.stringify({
      event: 'cron_tick',
      level: 'info',
      ok: true,
      cron,
      job,
      ms: Date.now() - started,
      posted: result.intents.length,
      ...result.fields,
    })
  );
}

function logTickFailure(cron: string, job: string, started: number, error: unknown): void {
  console.error(
    JSON.stringify({
      event: 'cron_tick',
      level: 'error',
      ok: false,
      cron,
      job,
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
  // Resolved up front so the failure path can name the job too.
  const job = jobForCron(controller.cron);
  try {
    const result = await dispatch(controller.cron, env, nowMs, fetchImpl);
    for (const intent of result.intents) {
      await sink(intent);
    }
    logTick(controller.cron, job, started, result);
  } catch (error) {
    // Log and rethrow: the heartbeat adds visibility, never swallows.
    logTickFailure(controller.cron, job, started, error);
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
    return { intents: [intent], fields: { pages, fetchedEvents, ingestedEvents } };
  }
  if (cron === CRON_DIGEST) {
    const { intent } = await runDailyDigest(env.DB, nowMs);
    return { intents: [intent], fields: {} };
  }
  if (cron === CRON_ALERT_SWEEP) {
    const { intents, conditions } = await runAlertSweep(env.DB, nowMs);
    const firing = conditions.filter((c) => c.firing).map((c) => c.kind);
    return { intents, fields: { firing } };
  }
  if (cron === CRON_POSTHOG_FLUSH) {
    // The only PostHog sender. Posts nothing to Zulip.
    const summary = await flushQueuedTurns(env.DB, env, nowMs);
    return { intents: [], fields: { ...summary } };
  }
  if (cron === CRON_MILESTONE_WATCH) {
    const { intents, crossings, count } = await runMilestoneWatch(env.DB, nowMs);
    return { intents, fields: { users: count, crossed: crossings.length } };
  }
  // Unknown cron pattern — surface loudly. wrangler.toml triggers and
  // the constants above must agree, so an unknown cron means a config
  // drift between deploy and code.
  throw new Error(`scheduled: no handler for cron pattern "${cron}"`);
}

export { runAlertSweep, runDailyDigest, runMilestoneWatch, runReconcile };
export { consoleSink, type PostIntent, type Sink } from './sink.js';
