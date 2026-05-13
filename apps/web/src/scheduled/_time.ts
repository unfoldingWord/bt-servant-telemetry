/**
 * Shared time helpers for scheduled jobs. Mirrors utcDayKey() in
 * ingest/upsert.ts and the DAY_KEY_SQL projection in api/queries.ts.
 * Kept here to avoid scheduled → api or scheduled → ingest-private
 * coupling beyond what's already needed.
 */

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function utcDayKey(ts: number): number {
  const d = new Date(ts);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

export function startOfUtcDayMs(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function dayKeysForOffset(nowMs: number, offsets: number[]): number[] {
  return offsets.map((o) => utcDayKey(nowMs - o * ONE_DAY_MS));
}

export function percentileSorted(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const loVal = sortedAsc.at(lo) ?? null;
  if (lo === hi) return loVal;
  const hiVal = sortedAsc.at(hi) ?? 0;
  const frac = rank - lo;
  return Math.round((loVal ?? 0) * (1 - frac) + hiVal * frac);
}
