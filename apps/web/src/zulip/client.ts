/**
 * Raw Zulip transport: a single `fetch` POST against the messages
 * endpoint. No SDK, no Python service — explicit non-goal in the plan.
 *
 * Auth: HTTP Basic with `<bot-email>:<bot-token>`. Body: form-encoded
 * with `type=stream&to=<stream>&topic=<topic>&content=<markdown>`.
 *
 * Errors — both HTTP non-2xx AND transport-level rejections (DNS, TLS,
 * connectivity) — are surfaced via the return value rather than thrown.
 * The caller (the sink adapter) decides what to do. Phase 7 chooses
 * log-loudly: the dedupe row has already been inserted by the scheduled
 * job, so a thrown error would either abort later intents in the sweep
 * or be retried on the next tick when dedupe blocks re-delivery. Either
 * way the message is lost — better to log it and keep going.
 */

export type ZulipConfig = {
  site: string; // e.g. https://example.zulipchat.com — NO trailing slash
  botEmail: string;
  botToken: string;
  stream: string;
  topic: string;
};

export type ZulipPostResult =
  | { ok: true; status: number }
  | { ok: false; reason: 'http'; status: number; body: string }
  | { ok: false; reason: 'transport'; error: string };

export async function postZulipMessage(
  config: ZulipConfig,
  content: string,
  fetchImpl: typeof fetch = fetch
): Promise<ZulipPostResult> {
  const body = new URLSearchParams({
    type: 'stream',
    to: config.stream,
    topic: config.topic,
    content,
  });
  const auth = btoa(`${config.botEmail}:${config.botToken}`);

  let response: Response;
  try {
    response = await fetchImpl(`${config.site}/api/v1/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
  } catch (err) {
    // Transport-level failure: DNS, TLS, socket close, AbortError, etc.
    // fetch() rejects with these before any HTTP status exists. Honor
    // the same non-throwing contract as HTTP non-2xx.
    return { ok: false, reason: 'transport', error: stringifyError(err) };
  }

  if (response.ok) return { ok: true, status: response.status };
  const errBody = await safeReadText(response);
  return { ok: false, reason: 'http', status: response.status, body: errBody };
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable response body>';
  }
}
