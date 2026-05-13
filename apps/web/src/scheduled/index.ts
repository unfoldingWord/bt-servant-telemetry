import type { BackfillEnv } from '../backfill/index.js';
import { runAlertSweep } from './alerts.js';
import { runDailyDigest } from './digest.js';
import { runMilestoneWatch } from './milestones.js';
import { runReconcile } from './reconcile.js';
import { consoleSink, type PostIntent, type Sink } from './sink.js';

export type ScheduledEnv = BackfillEnv;

// Cron pattern → job name. Kept here (rather than in wrangler.toml)
// because the dispatcher needs to switch on it; wrangler.toml triggers
// must mirror these strings exactly.
export const CRON_RECONCILE = '0 3 * * *';
export const CRON_DIGEST = '0 9 * * *';
export const CRON_ALERT_SWEEP = '*/5 * * * *';
export const CRON_MILESTONE_WATCH = '*/15 * * * *';

export type ScheduledOverrides = {
  sink?: Sink;
  fetchImpl?: typeof fetch;
  nowMs?: number;
};

export async function scheduledHandler(
  controller: ScheduledController,
  env: ScheduledEnv,
  _ctx: ExecutionContext,
  overrides: ScheduledOverrides = {}
): Promise<void> {
  const sink = overrides.sink ?? consoleSink;
  const fetchImpl = overrides.fetchImpl ?? fetch;
  const nowMs = overrides.nowMs ?? Date.now();
  const intents = await dispatch(controller.cron, env, nowMs, fetchImpl);
  for (const intent of intents) {
    await sink(intent);
  }
}

async function dispatch(
  cron: string,
  env: ScheduledEnv,
  nowMs: number,
  fetchImpl: typeof fetch
): Promise<PostIntent[]> {
  if (cron === CRON_RECONCILE) {
    const { intent } = await runReconcile(env, nowMs, fetchImpl);
    return [intent];
  }
  if (cron === CRON_DIGEST) {
    const { intent } = await runDailyDigest(env.DB, nowMs);
    return [intent];
  }
  if (cron === CRON_ALERT_SWEEP) {
    const { intents } = await runAlertSweep(env.DB, nowMs);
    return intents;
  }
  if (cron === CRON_MILESTONE_WATCH) {
    const { intents } = await runMilestoneWatch(env.DB, nowMs);
    return intents;
  }
  // Unknown cron pattern — surface loudly. wrangler.toml triggers and
  // the constants above must agree, so an unknown cron means a config
  // drift between deploy and code.
  throw new Error(`scheduled: no handler for cron pattern "${cron}"`);
}

export { runAlertSweep, runDailyDigest, runMilestoneWatch, runReconcile };
export { consoleSink, type PostIntent, type Sink } from './sink.js';
