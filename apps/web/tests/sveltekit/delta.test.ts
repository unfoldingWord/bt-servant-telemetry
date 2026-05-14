import { describe, it, expect } from 'vitest';
import { computeDelta, deltaQuality, type DeltaSignal } from '../../src/sveltekit/lib/delta.js';

describe('computeDelta', () => {
  it('returns null for null input', () => {
    expect(computeDelta(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(computeDelta(undefined)).toBeNull();
  });

  it('returns null when series has fewer than 6 points', () => {
    expect(computeDelta([1, 2, 3, 4, 5])).toBeNull();
  });

  it('returns flat when head average is zero and tail has data', () => {
    // Head (first ⅓) is all zeros, tail (last ⅓) has values.
    // This is the bug fix — previously returned { pctChange: 100, arrow: 'up' }.
    const series = [0, 0, 0, 5, 5, 10, 10, 10, 10];
    const result = computeDelta(series);
    expect(result).toEqual({ pctChange: 0, arrow: 'flat' });
  });

  it('returns flat when both head and tail are zero', () => {
    const series = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const result = computeDelta(series);
    expect(result).toEqual({ pctChange: 0, arrow: 'flat' });
  });

  it('returns up arrow when tail is higher than head', () => {
    const series = [10, 10, 10, 15, 15, 20, 20, 20, 20];
    const result = computeDelta(series)!;
    expect(result.arrow).toBe('up');
    expect(result.pctChange).toBeGreaterThan(0);
  });

  it('returns down arrow when tail is lower than head', () => {
    const series = [20, 20, 20, 15, 15, 10, 10, 10, 10];
    const result = computeDelta(series)!;
    expect(result.arrow).toBe('down');
    expect(result.pctChange).toBeLessThan(0);
  });

  it('returns flat when change is within 1% threshold', () => {
    // 100 → 100.5 = 0.5% change, below the 1% threshold
    const series = [100, 100, 100, 100, 100, 100.5, 100.5, 100.5, 100.5];
    const result = computeDelta(series);
    expect(result).toEqual({ pctChange: 0, arrow: 'flat' });
  });

  it('computes correct percentage for a known series', () => {
    // head avg = 10, tail avg = 15 → +50%
    const series = [10, 10, 10, 12, 12, 15, 15, 15, 15];
    const result = computeDelta(series)!;
    expect(result.arrow).toBe('up');
    expect(result.pctChange).toBeCloseTo(50, 0);
  });
});

describe('deltaQuality', () => {
  const up: DeltaSignal = { pctChange: 10, arrow: 'up' };
  const down: DeltaSignal = { pctChange: -10, arrow: 'down' };
  const flat: DeltaSignal = { pctChange: 0, arrow: 'flat' };

  it('maps up to good for higher_is_better', () => {
    expect(deltaQuality(up, 'higher_is_better')).toBe('good');
  });

  it('maps down to bad for higher_is_better', () => {
    expect(deltaQuality(down, 'higher_is_better')).toBe('bad');
  });

  it('maps up to bad for lower_is_better', () => {
    expect(deltaQuality(up, 'lower_is_better')).toBe('bad');
  });

  it('maps down to good for lower_is_better', () => {
    expect(deltaQuality(down, 'lower_is_better')).toBe('good');
  });

  it('maps flat to flat regardless of direction', () => {
    expect(deltaQuality(flat, 'higher_is_better')).toBe('flat');
    expect(deltaQuality(flat, 'lower_is_better')).toBe('flat');
  });
});
