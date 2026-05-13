/**
 * Cross-layer contract between scheduled jobs (the producer) and the
 * delivery layer (the consumer — console in dev, Zulip in prod).
 *
 * Lives in config/ rather than scheduled/ or zulip/ because both layers
 * need it and depcruise forbids zulip → scheduled imports. Config has
 * no business-layer imports of its own, so it's the natural home for
 * shared cross-cutting types.
 */

export const ALERT_KINDS = ['error_rate_high', 'worker_offline'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export type PostIntent =
  | { kind: 'reconcile'; markdown: string }
  | { kind: 'digest'; markdown: string }
  | { kind: 'alert'; alertKind: AlertKind; markdown: string }
  | { kind: 'milestone'; milestone: number; markdown: string };

export type Sink = (intent: PostIntent) => Promise<void>;
