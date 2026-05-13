/**
 * PostIntent — the structured output of a scheduled job.
 *
 * Scheduled jobs *compute* (KPIs, alert conditions, milestone crossings),
 * dedupe state in D1, and emit an intent. The actual delivery (Zulip POST,
 * console log, no-op) is decoupled via Sink so Phase 6 can ship the
 * dedupe-correct logic and Phase 7 can swap in the wire transport.
 */

export const ALERT_KINDS = ['error_rate_high', 'worker_offline'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export type PostIntent =
  | { kind: 'reconcile'; markdown: string }
  | { kind: 'digest'; markdown: string }
  | { kind: 'alert'; alertKind: AlertKind; markdown: string }
  | { kind: 'milestone'; milestone: number; markdown: string };

export type Sink = (intent: PostIntent) => Promise<void>;

/**
 * Default sink for Phase 6 — logs the intent. Phase 7 replaces this with
 * a Zulip POST. The handler layer wires in whichever sink the env wants;
 * scheduled jobs themselves are sink-agnostic.
 */
export const consoleSink: Sink = async (intent) => {
  console.log(`[scheduled] ${intent.kind}`, intent);
};
