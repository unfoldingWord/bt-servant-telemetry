import type { Sink } from '../config/sink.js';
import { postZulipMessage, type ZulipConfig } from './client.js';

/**
 * Adapts the raw Zulip transport into a `Sink` so the scheduled handler
 * can stream `PostIntent`s straight to Zulip. Every intent kind carries
 * a pre-formatted markdown body produced by the scheduled job, so the
 * sink just forwards it.
 *
 * Failures are logged, not thrown — see `client.ts` for the rationale.
 * Surfacing the error to the scheduled dispatcher would either abort
 * later jobs in the sweep or (worse) be retried on the next tick when
 * the dedupe row already exists.
 */
export function createZulipSink(config: ZulipConfig, fetchImpl: typeof fetch = fetch): Sink {
  return async (intent) => {
    const result = await postZulipMessage(config, intent.markdown, fetchImpl);
    if (!result.ok) {
      console.error(
        `zulip POST failed for intent kind=${intent.kind} status=${result.status} body=${result.body}`
      );
    }
  };
}
