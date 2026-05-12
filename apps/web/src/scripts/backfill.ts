import { runBackfill, type BackfillEnv } from '../backfill/index.js';

type BackfillScriptEnv = BackfillEnv & {
  TELEMETRY_EPOCH: string;
};

function parseTimestamp(input: string | null, fallback?: number): number {
  if (!input) {
    if (fallback !== undefined) return fallback;
    throw new Error('Missing required timestamp');
  }

  const numeric = Number(input);
  if (Number.isFinite(numeric)) return numeric;

  const parsed = Date.parse(input);
  if (Number.isFinite(parsed)) return parsed;

  throw new Error(`Invalid timestamp: ${input}`);
}

function parsePageSize(input: string | null): number | undefined {
  if (!input) return undefined;
  const parsed = Number(input);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error('pageSize must be an integer between 1 and 100');
  }
  return parsed;
}

const handler: ExportedHandler<BackfillScriptEnv> = {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Use POST /?since=<unix-ms-or-iso>&until=<unix-ms-or-iso>', {
        status: 405,
      });
    }

    try {
      const url = new URL(request.url);
      const since = parseTimestamp(
        url.searchParams.get('since'),
        parseTimestamp(env.TELEMETRY_EPOCH)
      );
      const until = parseTimestamp(url.searchParams.get('until'), Date.now());
      if (since >= until) throw new Error('since must be earlier than until');
      const pageSize = parsePageSize(url.searchParams.get('pageSize'));
      const summary = await runBackfill(
        env,
        pageSize === undefined
          ? { since, until }
          : {
              since,
              until,
              pageSize,
            }
      );
      return Response.json(summary);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : 'Unknown backfill failure' },
        { status: 400 }
      );
    }
  },
};

export default handler;
