/**
 * Display formatters for KPI values. Numbers always render with locale
 * separators and tabular figures; durations switch unit at the
 * second/minute boundaries to keep digit count visually steady.
 */

export type MetricFormat = 'integer' | 'percent' | 'duration_ms';

function formatPercent(value: number): string {
  if (value === 0) return '0%';
  if (value < 0.01) return '<0.01%';
  return `${value.toFixed(value < 1 ? 2 : 1)}%`;
}

function formatDurationMs(value: number): string {
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(2)}s`;
  return `${(value / 60_000).toFixed(1)}m`;
}

export function formatMetric(value: number | null, format: MetricFormat): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (format === 'integer') return Math.round(value).toLocaleString('en-US');
  if (format === 'percent') return formatPercent(value);
  return formatDurationMs(value);
}
