import type { Sink } from '../config/sink.js';

export { ALERT_KINDS, type AlertKind, type PostIntent, type Sink } from '../config/sink.js';

/**
 * Console sink — default when no Zulip secrets are configured. Useful for
 * `wrangler dev`, tests, and as a fallback when the worker is in an env
 * that has no upstream delivery target.
 */
export const consoleSink: Sink = async (intent) => {
  console.log(`[scheduled] ${intent.kind}`, intent);
};
