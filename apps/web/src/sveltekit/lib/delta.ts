/**
 * Momentum delta computed from a sparkline series. Compares the trailing
 * window (most recent) to the leading window (oldest) and returns the
 * percent change. Both windows are sized as ~⅓ of the series, capped at
 * 7 points, so a 30-point sparkline compares ~7-day vs ~7-day, and a
 * shorter series degrades gracefully.
 *
 * Direction interpretation belongs to the caller — error-rate +12% is
 * BAD, returning-users +12% is GOOD. Compute the signal here, color it
 * in the component.
 */

export type DeltaSignal = {
  /** Percent change, signed. 0 means flat. */
  pctChange: number;
  /** Direction: arrow shape only, no quality judgement. */
  arrow: 'up' | 'down' | 'flat';
};

const FLAT_THRESHOLD_PCT = 1;
const MAX_WINDOW = 7;

export function computeDelta(series: number[] | null | undefined): DeltaSignal | null {
  if (!series || series.length < 6) return null;
  const windowSize = Math.min(MAX_WINDOW, Math.floor(series.length / 3));
  if (windowSize < 2) return null;

  const tail = series.slice(-windowSize);
  const head = series.slice(0, windowSize);
  const tailAvg = avg(tail);
  const headAvg = avg(head);

  if (headAvg === 0) {
    if (tailAvg === 0) return { pctChange: 0, arrow: 'flat' };
    return { pctChange: 100, arrow: 'up' };
  }
  const pctChange = ((tailAvg - headAvg) / headAvg) * 100;
  if (Math.abs(pctChange) < FLAT_THRESHOLD_PCT) {
    return { pctChange: 0, arrow: 'flat' };
  }
  return { pctChange, arrow: pctChange > 0 ? 'up' : 'down' };
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export type MetricDirection = 'higher_is_better' | 'lower_is_better';

export function deltaQuality(
  signal: DeltaSignal,
  direction: MetricDirection
): 'good' | 'bad' | 'flat' {
  if (signal.arrow === 'flat') return 'flat';
  if (direction === 'higher_is_better') {
    return signal.arrow === 'up' ? 'good' : 'bad';
  }
  return signal.arrow === 'up' ? 'bad' : 'good';
}
