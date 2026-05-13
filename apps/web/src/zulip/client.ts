/**
 * Raw Zulip transport: a single `fetch` POST against the messages
 * endpoint. No SDK, no Python service — explicit non-goal in the plan.
 *
 * Auth: HTTP Basic with `<bot-email>:<bot-token>`. Body: form-encoded
 * with `type=stream&to=<stream>&topic=<topic>&content=<markdown>`.
 *
 * Errors are surfaced via the return value (a `ZulipPostResult`)
 * rather than thrown. The caller (the sink adapter) decides whether a
 * failed POST should crash the sweep, log loudly, or be silently
 * absorbed. Phase 7 chooses log-loudly: the dedupe row has already been
 * inserted by the scheduled job, so retrying would either be ignored
 * (and silent) or require unwinding the dedupe — neither is worth it.
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
  | { ok: false; status: number; body: string };

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
  const response = await fetchImpl(`${config.site}/api/v1/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (response.ok) return { ok: true, status: response.status };
  const errBody = await safeReadText(response);
  return { ok: false, status: response.status, body: errBody };
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable response body>';
  }
}
